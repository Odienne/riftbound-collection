import { Injectable, signal } from '@angular/core';
import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

export interface AuthResult {
  user: User | null;
  error: string | null;
  confirmationRequired: boolean;
}

const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const AUTH_COOKIE_CHUNK_SIZE = 3000;

function createCookieStorage() {
  const readCookies = (): Map<string, string> => {
    const cookies = new Map<string, string>();
    for (const part of document.cookie.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1));
    }
    return cookies;
  };

  const writeCookie = (name: string, value: string, maxAge: number): void => {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  };

  const removeItem = (key: string): void => {
    const chunkPrefix = `${key}.`;
    for (const name of readCookies().keys()) {
      const suffix = name.startsWith(chunkPrefix) ? name.slice(chunkPrefix.length) : '';
      if (name === key || /^\d+$/.test(suffix)) writeCookie(name, '', 0);
    }
  };

  return {
    getItem(key: string): string | null {
      const cookies = readCookies();
      const directValue = cookies.get(key);
      if (directValue !== undefined) {
        try {
          return decodeURIComponent(directValue);
        } catch {
          return null;
        }
      }

      const chunkPrefix = `${key}.`;
      const chunks = [...cookies.entries()]
        .flatMap(([name, value]) => {
          if (!name.startsWith(chunkPrefix)) return [];
          const index = name.slice(chunkPrefix.length);
          return /^\d+$/.test(index) ? [{ index: Number(index), value }] : [];
        })
        .sort((left, right) => left.index - right.index);

      if (!chunks.length || chunks.some((chunk, index) => chunk.index !== index)) return null;
      try {
        return decodeURIComponent(chunks.map((chunk) => chunk.value).join(''));
      } catch {
        return null;
      }
    },

    setItem(key: string, value: string): void {
      removeItem(key);
      const encodedValue = encodeURIComponent(value);
      if (encodedValue.length <= AUTH_COOKIE_CHUNK_SIZE) {
        writeCookie(key, encodedValue, AUTH_COOKIE_MAX_AGE_SECONDS);
        return;
      }

      for (let offset = 0, index = 0; offset < encodedValue.length; offset += AUTH_COOKIE_CHUNK_SIZE, index += 1) {
        writeCookie(
          `${key}.${index}`,
          encodedValue.slice(offset, offset + AUTH_COOKIE_CHUNK_SIZE),
          AUTH_COOKIE_MAX_AGE_SECONDS,
        );
      }
    },
    removeItem,
  };
}

@Injectable({ providedIn: 'root' })
export class SupabaseAuthService {
  private clientInstance: SupabaseClient | null = null;
  private initialization: Promise<void> | null = null;

  readonly isConfigured = signal(false);
  readonly isReady = signal(false);
  readonly isBusy = signal(false);
  readonly user = signal<User | null>(null);
  readonly configurationError = signal<string | null>(null);

  get client(): SupabaseClient | null {
    return this.clientInstance;
  }

  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.initializeClient();
    return this.initialization;
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const client = this.clientInstance;
    if (!client) return this.authUnavailable();

    this.isBusy.set(true);
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) return { user: null, error: this.translateError(error.message), confirmationRequired: false };
      this.user.set(data.user);
      return { user: data.user, error: null, confirmationRequired: false };
    } catch {
      return { user: null, error: 'Connexion impossible. Vérifie ta connexion puis réessaie.', confirmationRequired: false };
    } finally {
      this.isBusy.set(false);
    }
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    const client = this.clientInstance;
    if (!client) return this.authUnavailable();

    this.isBusy.set(true);
    try {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) return { user: null, error: this.translateError(error.message), confirmationRequired: false };

      if (data.session) this.user.set(data.user);
      return {
        user: data.session ? data.user : null,
        error: null,
        confirmationRequired: !data.session,
      };
    } catch {
      return { user: null, error: 'Création du compte impossible. Réessaie dans un instant.', confirmationRequired: false };
    } finally {
      this.isBusy.set(false);
    }
  }

  async signOut(): Promise<string | null> {
    const client = this.clientInstance;
    if (!client) return null;

    const { error } = await client.auth.signOut();
    if (error) return this.translateError(error.message);
    this.user.set(null);
    return null;
  }

  private async initializeClient(): Promise<void> {
    if (!environment.supabaseUrl.trim() || !environment.supabaseKey.trim()) {
      this.isReady.set(true);
      return;
    }

    try {
      const supabaseUrl = environment.supabaseUrl.trim();
      const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
      const storageKey = `sb-${projectRef}-auth-token`;
      const cookieStorage = createCookieStorage();

      // Carry the current tab's session across this storage change without asking for another login.
      try {
        const previousSession = window.sessionStorage.getItem(storageKey);
        if (previousSession && !cookieStorage.getItem(storageKey)) {
          cookieStorage.setItem(storageKey, previousSession);
        }
        if (previousSession) window.sessionStorage.removeItem(storageKey);
      } catch {
        // Session storage can be unavailable in restricted browser contexts.
      }

      this.clientInstance = createClient(environment.supabaseUrl.trim(), environment.supabaseKey.trim(), {
        auth: {
          storage: cookieStorage,
          storageKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      this.isConfigured.set(true);

      this.clientInstance.auth.onAuthStateChange((_event, session) => {
        queueMicrotask(() => {
          this.user.set(session?.user ?? null);
          this.isReady.set(true);
        });
      });

      const { data, error } = await this.clientInstance.auth.getSession();
      if (error) throw error;
      this.user.set(data.session?.user ?? null);
    } catch {
      this.clientInstance = null;
      this.isConfigured.set(false);
      this.configurationError.set('La configuration Supabase est invalide. Vérifie l’URL et la clé publique dans src/environments/environment.ts.');
    } finally {
      this.isReady.set(true);
    }
  }

  private authUnavailable(): AuthResult {
    return {
      user: null,
      error: 'Supabase n’est pas configuré. Ajoute l’URL du projet et sa clé publique dans src/environments/environment.ts.',
      confirmationRequired: false,
    };
  }

  private translateError(message: string): string {
    const normalized = message.toLocaleLowerCase('en');
    if (normalized.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
    if (normalized.includes('user already registered')) return 'Un compte existe déjà pour cette adresse e-mail.';
    if (normalized.includes('password should be at least')) return 'Le mot de passe doit contenir au moins 6 caractères.';
    if (normalized.includes('email not confirmed')) return 'Confirme ton adresse e-mail depuis le message envoyé par Supabase.';
    return message;
  }
}
