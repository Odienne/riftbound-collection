# Riftbound Collection

Une application Angular pour suivre sa collection Riftbound avec un compte e-mail/mot de passe. La copie JSON de chaque collection est conservée dans Supabase, associée à l’identifiant du compte et protégée par Row Level Security (RLS).

## Configuration Supabase

1. Dans le tableau de bord Supabase, copie le **Project URL** et la clé **publishable** depuis **Connect**.
2. Renseigne ces deux valeurs dans [`src/environments/environment.ts`](src/environments/environment.ts), dans `supabaseUrl` et `supabaseKey`.
3. Dans le **SQL Editor** du projet Supabase, exécute [`supabase/migrations/202611240001_create_user_collections.sql`](supabase/migrations/202611240001_create_user_collections.sql). Cette migration crée `public.user_collections`, avec une ligne JSONB par compte et des politiques RLS limitant lecture et écriture à `auth.uid()`.
4. Si la confirmation des e-mails est activée, définis `http://localhost:4200` comme URL du site dans **Authentication → URL Configuration**.

La clé publishable est destinée au navigateur. N’insère jamais de clé Supabase `secret` ou `service_role` dans l’application : ces clés contournent RLS. Les jetons de session d’authentification restent dans `sessionStorage`; le JSON de collection est sauvegardé sur Supabase et n’est pas placé dans le stockage local du navigateur.

## Lancer l’application

Node.js 22.12 ou plus récent est nécessaire pour Angular 21.

```bash
npm install
npm start
```

L’application est ensuite disponible sur `http://localhost:4200`.

## Collections et catalogue

- Un compte peut posséder une collection. **Démarrer ma collection** copie le catalogue dans `public.user_collections` avec les quantités à zéro.
- Les boutons `+` et `−` mettent à jour le JSON de la collection. Les changements sont regroupés sur une courte fenêtre de 450 ms avant l’écriture Supabase.
- À la reconnexion, l’application charge la collection du compte. Le catalogue se rafraîchit automatiquement au plus une fois toutes les six heures ; **Actualiser** force une lecture. Les quantités sont conservées, les nouvelles cartes commencent à zéro et les cartes retirées du catalogue restent dans la collection.
- **Exporter** permet de télécharger une copie JSON de sauvegarde.
- Le catalogue vient du split `train` de `Wysme/riftbound-cards` via le Datasets Server public de Hugging Face, miroir du dépôt communautaire [LouisCourrian/riftbound-cards](https://github.com/LouisCourrian/riftbound-cards).

Le catalogue est communautaire et n’est pas affilié à Riot Games. Les noms, textes et illustrations des cartes appartiennent à Riot Games.

## Stack

- Angular 21, composants standalone et signals
- Tailwind CSS 4
- Spartan UI, composants Angular accessibles inspirés de l’approche shadcn/ui
- Supabase Auth et Postgres JSONB avec RLS
