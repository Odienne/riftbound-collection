import { Injectable, computed, signal } from '@angular/core';
import type { CollectionCard, CollectionSnapshot, RiftboundCard } from '../models/card.model';
import { SupabaseAuthService } from './supabase-auth.service';

interface DatasetRow {
  row: Record<string, unknown>;
}

interface DatasetPage {
  rows: DatasetRow[];
  num_rows_total: number;
  num_rows_per_page: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const DATASET_ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const DATASET_ID = 'Wysme/riftbound-cards';
const DATASET_CONFIG = 'default';
const DATASET_SPLIT = 'train';
const FALLBACK_PAGE_SIZE = 100;
const SAVE_DEBOUNCE_MS = 450;

@Injectable({ providedIn: 'root' })
export class CollectionService {
  readonly snapshot = signal<CollectionSnapshot | null>(null);
  readonly cards = computed(() => this.snapshot()?.cards ?? []);
  readonly isStarted = computed(() => this.snapshot() !== null);
  readonly isLoading = signal(false);
  readonly hasLoaded = signal(false);
  readonly loadFailed = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveState = signal<SaveState>('idle');
  readonly saveError = signal<string | null>(null);

  private userId: string | null = null;
  private loadVersion = 0;
  private saveVersion = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly auth: SupabaseAuthService) {}

  async loadForUser(userId: string): Promise<void> {
    const loadVersion = ++this.loadVersion;
    this.cancelScheduledSave();
    this.saveVersion += 1;
    this.userId = userId;
    this.snapshot.set(null);
    this.hasLoaded.set(false);
    this.loadFailed.set(false);
    this.loadError.set(null);
    this.saveError.set(null);
    this.saveState.set('idle');

    const client = this.auth.client;
    if (!client) {
      this.loadError.set('Supabase n’est pas configuré. Vérifie src/environments/environment.ts.');
      this.hasLoaded.set(true);
      return;
    }

    this.isLoading.set(true);
    try {
      const { data, error } = await client
        .from('user_collections')
        .select('collection')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      if (loadVersion !== this.loadVersion) return;

      if (data?.collection) {
        const saved = data.collection as CollectionSnapshot;
        if (saved.version !== 1 || !Array.isArray(saved.cards)) {
          throw new Error('Stored collection has an unsupported format.');
        }
        this.snapshot.set(saved);
        this.saveState.set('saved');
      }
    } catch {
      if (loadVersion === this.loadVersion) {
        this.loadFailed.set(true);
        this.loadError.set(
          'Impossible de charger la collection du compte. Vérifie la table et les politiques RLS Supabase, puis réessaie.',
        );
      }
    } finally {
      if (loadVersion === this.loadVersion) {
        this.isLoading.set(false);
        this.hasLoaded.set(true);
      }
    }
  }

  clearForSignOut(): void {
    this.loadVersion += 1;
    this.saveVersion += 1;
    this.cancelScheduledSave();
    this.userId = null;
    this.snapshot.set(null);
    this.isLoading.set(false);
    this.hasLoaded.set(false);
    this.loadFailed.set(false);
    this.loadError.set(null);
    this.saveError.set(null);
    this.saveState.set('idle');
  }

  async startCollection(): Promise<void> {
    const userId = this.userId;
    if (!userId || this.isLoading()) return;

    this.isLoading.set(true);
    this.loadError.set(null);
    this.saveError.set(null);

    try {
      const catalogue = await this.fetchLatestCatalogue();
      if (userId !== this.userId) return;

      const now = new Date().toISOString();
      const snapshot: CollectionSnapshot = {
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
        sourceRevision: catalogue.revision,
        cards: catalogue.cards.map((card) => ({ ...card, quantity: 0 })),
      };
      this.snapshot.set(snapshot);
      this.saveState.set('saving');
      await this.persistSnapshot(userId, snapshot, ++this.saveVersion);
    } catch {
      if (userId === this.userId && !this.snapshot()) {
        this.loadError.set(
          'Le catalogue Riftbound est momentanément inaccessible. Vérifie ta connexion et réessaie.',
        );
      }
    } finally {
      if (userId === this.userId) this.isLoading.set(false);
    }
  }

  async syncLatestCatalogue(force = false): Promise<void> {
    const userId = this.userId;
    const current = this.snapshot();
    if (!userId || !current || this.isLoading()) return;

    const lastSync = Date.parse(current.lastSyncedAt);
    if (!force && Number.isFinite(lastSync) && Date.now() - lastSync < 6 * 60 * 60 * 1000) return;

    this.isLoading.set(true);
    this.loadError.set(null);

    let catalogue: { cards: RiftboundCard[]; revision: string | null };
    try {
      catalogue = await this.fetchLatestCatalogue();
    } catch {
      this.loadError.set(
        'La collection est chargée, mais la dernière mise à jour du catalogue n’a pas abouti.',
      );
      this.isLoading.set(false);
      return;
    }

    try {
      if (userId !== this.userId) return;
      const latestSnapshot = this.snapshot() ?? current;
      const quantities = new Map(latestSnapshot.cards.map((card) => [card.cardCode, card.quantity]));
      const latestCodes = new Set(catalogue.cards.map((card) => card.cardCode));
      const merged: CollectionCard[] = catalogue.cards.map((card) => ({
        ...card,
        quantity: quantities.get(card.cardCode) ?? 0,
      }));

      // Keep owned cards if a later upstream snapshot removes them from the gallery.
      for (const oldCard of latestSnapshot.cards) {
        if (!latestCodes.has(oldCard.cardCode)) merged.push(oldCard);
      }

      const updated: CollectionSnapshot = {
        ...latestSnapshot,
        lastSyncedAt: new Date().toISOString(),
        sourceRevision: catalogue.revision,
        cards: merged,
      };
      this.cancelScheduledSave();
      this.snapshot.set(updated);
      this.saveState.set('saving');
      await this.persistSnapshot(userId, updated, ++this.saveVersion);
    } catch {
      this.loadError.set('Le catalogue a été mis à jour, mais sa sauvegarde sur le compte a échoué.');
    } finally {
      if (userId === this.userId) this.isLoading.set(false);
    }
  }

  changeQuantity(cardCode: string, delta: number): void {
    const current = this.snapshot();
    if (!current) return;

    const card = current.cards.find((entry) => entry.cardCode === cardCode);
    if (!card) return;

    const quantity = Math.max(0, card.quantity + delta);
    if (quantity === card.quantity) return;

    this.snapshot.set({
      ...current,
      updatedAt: new Date().toISOString(),
      cards: current.cards.map((entry) =>
        entry.cardCode === cardCode ? { ...entry, quantity } : entry,
      ),
    });
    this.scheduleSave();
  }

  async flushPendingSave(): Promise<void> {
    const userId = this.userId;
    const snapshot = this.snapshot();

    if (this.saveTimer && userId && snapshot) {
      this.cancelScheduledSave();
      await this.persistSnapshot(userId, snapshot, this.saveVersion);
      return;
    }

    await this.saveQueue;
    if (this.saveState() === 'error') throw new Error(this.saveError() ?? 'Collection save failed.');
  }

  exportCollection(): string | null {
    const current = this.snapshot();
    return current ? JSON.stringify(current, null, 2) : null;
  }

  private scheduleSave(): void {
    const userId = this.userId;
    const snapshot = this.snapshot();
    if (!userId || !snapshot) return;

    const version = ++this.saveVersion;
    this.saveState.set('saving');
    this.saveError.set(null);
    this.cancelScheduledSave();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistSnapshot(userId, snapshot, version).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }

  private async persistSnapshot(
    userId: string,
    snapshot: CollectionSnapshot,
    version: number,
  ): Promise<void> {
    const client = this.auth.client;
    if (!client) throw new Error('Supabase is not configured.');

    const queuedSave = this.saveQueue.catch(() => undefined).then(async () => {
      const { error } = await client.from('user_collections').upsert(
        {
          user_id: userId,
          collection: snapshot,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
    });
    this.saveQueue = queuedSave;

    try {
      await queuedSave;
      if (version === this.saveVersion && userId === this.userId) {
        this.saveState.set('saved');
        this.saveError.set(null);
      }
    } catch {
      if (version === this.saveVersion && userId === this.userId) {
        this.saveState.set('error');
        this.saveError.set('La collection n’a pas pu être sauvegardée sur Supabase. Réessaie.');
      }
      throw new Error('Supabase collection upsert failed.');
    }
  }

  private cancelScheduledSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async fetchLatestCatalogue(): Promise<{
    cards: RiftboundCard[];
    revision: string | null;
  }> {
    const first = await this.fetchPage(0, FALLBACK_PAGE_SIZE);
    const total = first.page.num_rows_total;
    const pageSize = first.page.num_rows_per_page || FALLBACK_PAGE_SIZE;
    const pages: DatasetPage[] = [first.page];
    const offsets: number[] = [];

    for (let offset = first.page.rows.length; offset < total; offset += pageSize) {
      offsets.push(offset);
    }

    for (let index = 0; index < offsets.length; index += 4) {
      const batch = offsets.slice(index, index + 4);
      const batchPages = await Promise.all(
        batch.map((offset) => this.fetchPage(offset, pageSize)),
      );
      pages.push(...batchPages.map((result) => result.page));
    }

    const cards = pages.flatMap((page) => page.rows.map(({ row }) => this.mapCard(row)));
    if (cards.length === 0) throw new Error('The upstream dataset is empty.');
    return { cards, revision: first.revision };
  }

  private async fetchPage(
    offset: number,
    length: number,
  ): Promise<{ page: DatasetPage; revision: string | null }> {
    const query = new URLSearchParams({
      dataset: DATASET_ID,
      config: DATASET_CONFIG,
      split: DATASET_SPLIT,
      offset: String(offset),
      length: String(length),
    });
    const response = await fetch(`${DATASET_ROWS_URL}?${query}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) throw new Error(`Dataset request failed with ${response.status}.`);
    return {
      page: (await response.json()) as DatasetPage,
      revision: response.headers.get('x-revision'),
    };
  }

  private mapCard(row: Record<string, unknown>): RiftboundCard {
    const cardCode = String(row['card_code'] ?? '');
    return {
      cardCode,
      name: String(row['name'] ?? 'Carte inconnue'),
      subtitle: this.asNullableString(row['subtitle']),
      fullName: String(row['full_name'] ?? row['name'] ?? 'Carte inconnue'),
      setCode: String(row['set_code'] ?? 'unknown'),
      cardSet: String(row['card_set'] ?? 'Extension inconnue'),
      cardNumber: String(row['card_number'] ?? cardCode),
      rarity: String(row['rarity'] ?? 'Inconnue'),
      domain: String(row['domain'] ?? 'Neutre'),
      domains: this.asStringArray(row['domains']),
      cardType: String(row['card_type'] ?? 'Carte'),
      cardTypeLabels: this.asStringArray(row['card_type_labels']),
      tags: this.asStringArray(row['tags']),
      energy: this.asNullableNumber(row['energy']),
      power: this.asNullableNumber(row['power']),
      might: this.asNullableNumber(row['might']),
      abilityOriginal: this.asNullableString(row['ability_original']),
      abilityCorrected: this.asNullableString(row['ability_corrected']),
      abilityEffective: this.asNullableString(row['ability_effective']),
      hasErrata: Boolean(row['has_errata']),
      matchedErrataCode: this.asNullableString(row['matched_errata_code']),
      artist: this.asNullableString(row['artist']),
      imageUrl: this.asNullableString(row['image_url']),
      sourceUrl: this.asNullableString(row['source_url']),
      scrapedAt: this.asNullableString(row['scraped_at']),
    };
  }

  private asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private asNullableString(value: unknown): string | null {
    return value === null || value === undefined || value === '' ? null : String(value);
  }

  private asNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
