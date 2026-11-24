export interface RiftboundCard {
  cardCode: string;
  name: string;
  subtitle: string | null;
  fullName: string;
  setCode: string;
  cardSet: string;
  cardNumber: string;
  rarity: string;
  domain: string;
  domains: string[];
  cardType: string;
  cardTypeLabels: string[];
  tags: string[];
  energy: number | null;
  power: number | null;
  might: number | null;
  abilityOriginal: string | null;
  abilityCorrected: string | null;
  abilityEffective: string | null;
  hasErrata: boolean;
  matchedErrataCode: string | null;
  artist: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  scrapedAt: string | null;
}

export interface CollectionCard extends RiftboundCard {
  quantity: number;
}

export interface CollectionSnapshot {
  version: 1;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string;
  sourceRevision: string | null;
  cards: CollectionCard[];
}

export interface RiftboundExtension {
  code: string;
  name: string;
  total: number;
  owned: number;
}
