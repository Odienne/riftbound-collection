import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { CollectionService } from './services/collection.service';
import { SupabaseAuthService } from './services/supabase-auth.service';
import type { CollectionCard, CollectionSnapshot, RiftboundExtension } from './models/card.model';

type CollectionFilter = 'all' | 'owned' | 'missing';

interface CardTypeFilter {
  id: string;
  label: string;
  cardType?: string;
  championUnits?: boolean;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, HlmButtonImports],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly collection = inject(CollectionService);
  protected readonly auth = inject(SupabaseAuthService);
  protected readonly activeExtension = signal('all');
  protected readonly activeFilter = signal<CollectionFilter>('all');
  protected readonly activeCardType = signal('all');
  protected readonly searchTerm = signal('');
  protected readonly authMode = signal<'login' | 'signup'>('login');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly authError = signal<string | null>(null);
  protected readonly authMessage = signal<string | null>(null);
  protected readonly publicShareId = signal<string | null>(null);
  protected readonly publicProfileSnapshot = signal<CollectionSnapshot | null>(null);
  protected readonly publicProfileLoading = signal(false);
  protected readonly publicProfileError = signal<string | null>(null);
  protected readonly shareCopied = signal(false);
  protected readonly shareCopyError = signal<string | null>(null);
  protected readonly isPublicProfile = computed(() => this.publicShareId() !== null);
  protected readonly publicShareUrl = computed(() => {
    const shareId = this.collection.shareId();
    if (!shareId) return null;

    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('share', shareId);
    return url.toString();
  });
  protected readonly displayCards = computed(() =>
    this.isPublicProfile()
      ? this.publicProfileSnapshot()?.cards ?? []
      : this.collection.cards(),
  );

  protected readonly extensions = computed<RiftboundExtension[]>(() => {
    const summary = new Map<string, RiftboundExtension>();

    for (const card of this.displayCards()) {
      const extension = summary.get(card.setCode) ?? {
        code: card.setCode,
        name: card.cardSet,
        total: 0,
        owned: 0,
      };
      extension.total += 1;
      if (card.quantity > 0) extension.owned += 1;
      summary.set(card.setCode, extension);
    }

    return [...summary.values()];
  });

  protected readonly cardTypeFilters = computed<CardTypeFilter[]>(() => {
    const cards = this.displayCards();
    const types = new Set(cards.map((card) => card.cardType.trim()).filter(Boolean));
    const filters: CardTypeFilter[] = [{ id: 'all', label: 'Tous les types' }];
    const addType = (match: RegExp, label: string) => {
      const cardType = [...types].find((type) => match.test(type));
      if (cardType) {
        filters.push({ id: `type:${cardType.toLocaleLowerCase('en')}`, label, cardType });
        types.delete(cardType);
      }
    };

    addType(/^legend(s)?$/i, 'Legends');
    addType(/^spell(s)?$/i, 'Sorts');

    const hasChampionUnits = cards.some((card) => this.isChampionUnit(card));
    const unitType = [...types].find((type) => /^unit(s)?$/i.test(type));
    if (hasChampionUnits) {
      filters.push({ id: 'champion-units', label: 'Champion Units', championUnits: true });
    }
    if (unitType) {
      filters.push({ id: `type:${unitType.toLocaleLowerCase('en')}`, label: 'Units', cardType: unitType });
      types.delete(unitType);
    }

    addType(/^gear(s)?$/i, 'Gears');
    for (const cardType of [...types].sort((left, right) => left.localeCompare(right, 'en'))) {
      if (hasChampionUnits && /^champion\s+units?$/i.test(cardType)) continue;
      filters.push({
        id: `type:${cardType.toLocaleLowerCase('en')}`,
        label: cardType,
        cardType,
      });
    }

    return filters;
  });

  protected readonly ownedUniqueCount = computed(
    () => this.displayCards().filter((card) => card.quantity > 0).length,
  );
  protected readonly totalCopies = computed(() =>
    this.displayCards().reduce((sum, card) => sum + card.quantity, 0),
  );
  protected readonly completionPercent = computed(() => {
    const total = this.displayCards().length;
    return total ? Math.round((this.ownedUniqueCount() / total) * 100) : 0;
  });

  protected readonly visibleCards = computed(() => {
    const extensionCode = this.activeExtension();
    const filter = this.activeFilter();
    const selectedType = this.cardTypeFilters().find((item) => item.id === this.activeCardType());
    const query = this.searchTerm().trim().toLocaleLowerCase('fr');

    return this.displayCards()
      .filter((card) => extensionCode === 'all' || card.setCode === extensionCode)
      .filter((card) => {
        if (!selectedType || selectedType.id === 'all') return true;
        if (selectedType.championUnits) return this.isChampionUnit(card);
        return card.cardType === selectedType.cardType;
      })
      .filter((card) => {
        if (filter === 'owned') return card.quantity > 0;
        if (filter === 'missing') return card.quantity === 0;
        return true;
      })
      .filter((card) => {
        if (!query) return true;
        return [card.fullName, card.cardSet, card.cardNumber, card.cardCode, card.domain]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase('fr').includes(query));
      })
      .sort(
        (left, right) =>
          left.setCode.localeCompare(right.setCode, 'fr') ||
          left.cardNumber.localeCompare(right.cardNumber, 'fr'),
      );
  });

  async ngOnInit(): Promise<void> {
    const shareId = new URLSearchParams(window.location.search).get('share');
    if (shareId !== null) this.publicShareId.set(shareId);

    await this.auth.initialize();

    if (shareId !== null) {
      if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(shareId)) {
        this.publicProfileError.set('Ce lien de collection est invalide.');
        return;
      }

      this.publicProfileLoading.set(true);
      try {
        this.publicProfileSnapshot.set(await this.collection.fetchPublicCollection(shareId));
      } catch {
        this.publicProfileError.set('Cette collection est introuvable ou son partage a été désactivé.');
      } finally {
        this.publicProfileLoading.set(false);
      }
      return;
    }

    const user = this.auth.user();
    if (user) {
      await this.collection.loadForUser(user.id);
      if (this.collection.isStarted()) void this.collection.syncLatestCatalogue();
    }
  }

  protected setAuthMode(mode: 'login' | 'signup'): void {
    this.authMode.set(mode);
    this.authError.set(null);
    this.authMessage.set(null);
  }

  protected async submitAuth(): Promise<void> {
    this.authError.set(null);
    this.authMessage.set(null);
    const email = this.email().trim();
    const password = this.password();

    if (!email || !password) {
      this.authError.set('Renseigne ton adresse e-mail et ton mot de passe.');
      return;
    }
    if (this.authMode() === 'signup' && password.length < 6) {
      this.authError.set('Choisis un mot de passe d’au moins 6 caractères.');
      return;
    }

    const result =
      this.authMode() === 'signup'
        ? await this.auth.signUp(email, password)
        : await this.auth.signIn(email, password);

    if (result.error) {
      this.authError.set(result.error);
      return;
    }
    if (result.confirmationRequired) {
      this.authMessage.set('Compte créé. Vérifie l’e-mail envoyé par Supabase pour confirmer ton adresse, puis connecte-toi.');
      this.authMode.set('login');
      return;
    }
    if (result.user) {
      await this.collection.loadForUser(result.user.id);
      if (this.collection.loadFailed()) this.authError.set(this.collection.loadError());
    }
  }

  protected async signOut(): Promise<void> {
    this.authError.set(null);
    try {
      await this.collection.flushPendingSave();
    } catch {
      this.authError.set('La dernière modification n’a pas été sauvegardée. Vérifie ta connexion puis réessaie.');
      return;
    }

    const error = await this.auth.signOut();
    if (error) {
      this.authError.set(error);
      return;
    }
    this.collection.clearForSignOut();
  }

  protected async retryCollectionLoad(): Promise<void> {
    const user = this.auth.user();
    if (user) await this.collection.loadForUser(user.id);
  }

  protected setFilter(filter: CollectionFilter): void {
    this.activeFilter.set(filter);
  }

  protected setCardTypeFilter(filterId: string): void {
    this.activeCardType.set(filterId);
  }

  protected async setPublicSharing(enabled: boolean): Promise<void> {
    this.shareCopied.set(false);
    this.shareCopyError.set(null);
    await this.collection.setPublicSharing(enabled);
  }

  protected async copyShareLink(): Promise<void> {
    const url = this.publicShareUrl();
    if (!url) return;

    this.shareCopied.set(false);
    this.shareCopyError.set(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      this.shareCopied.set(true);
      window.setTimeout(() => this.shareCopied.set(false), 2200);
    } catch {
      this.shareCopyError.set('La copie automatique est indisponible. Sélectionne le lien pour le copier.');
    }
  }

  private isChampionUnit(card: CollectionCard): boolean {
    const labels = [card.cardType, ...card.cardTypeLabels].map((label) => label.trim());
    const hasChampion = labels.some((label) => /^champion(s)?$/i.test(label)) ||
      labels.some((label) => /champion\s+units?/i.test(label));
    const hasUnit = labels.some((label) => /^units?$/i.test(label)) ||
      labels.some((label) => /champion\s+units?/i.test(label));
    return hasChampion && hasUnit;
  }

  protected setExtension(extensionCode: string): void {
    this.activeExtension.set(extensionCode);
  }

  protected onExtensionKeydown(event: KeyboardEvent, index: number): void {
    const tabCount = this.extensions().length + 1;
    let nextIndex = index;

    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabCount;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabCount) % tabCount;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabCount - 1;
    else return;

    event.preventDefault();
    const tabs = document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  }

  protected updateSearch(value: string): void {
    this.searchTerm.set(value);
  }

  protected changeQuantity(card: CollectionCard, delta: number): void {
    this.collection.changeQuantity(card.cardCode, delta);
  }

  protected hideBrokenImage(event: Event): void {
    const image = event.target as HTMLImageElement | null;
    if (!image) return;
    image.hidden = true;
    const fallback = image.parentElement?.querySelector<HTMLElement>('.card-image-empty');
    if (fallback) fallback.hidden = false;
  }

  protected async refreshCatalogue(): Promise<void> {
    await this.collection.syncLatestCatalogue(true);
  }

  protected downloadCollection(): void {
    const json = this.collection.exportCollection();
    if (!json) return;

    const file = new Blob([json], { type: 'application/json' });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `riftbound-collection-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(fileUrl);
  }
}
