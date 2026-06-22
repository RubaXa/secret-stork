# names-roulette — инструкции для агента

## Деплой

**GitHub Actions заблокирован** из-за billing issue на аккаунте RubaXa. Не пытаться его включать.

Деплой делается вручную через ветку `gh-pages`:

```bash
npm run build
git checkout --orphan gh-pages-deploy
git reset --hard
cp -r dist/* .
git add -f index.html assets/ chart.html
git commit -m "Deploy"
git push origin gh-pages-deploy:gh-pages --force
git checkout main
git branch -D gh-pages-deploy
```

**Делать это при каждом коммите в main**, который меняет исходники (`src/`, `public/`, `index.html`, `vite.config.js`).

GitHub Pages настроен на ветку `gh-pages`, папка `/ (root)`.
Сайт: https://rubaxa.github.io/names-roulette/

## Стек

- Vue 3 + Vite 8, hash-роутер (`createWebHashHistory`)
- Firebase CDN (не npm), `base: '/names-roulette/'`
- IndexedDB (idb@8) — local-first, Firebase — синхронизация
- E2E: Playwright (порт 4173), unit: Vitest

## Неочевидные места

- [`src/firebase/config.js:1`](src/firebase/config.js) — Firebase грузится с CDN (gstatic), а не npm. Причина: GitHub Pages, нет серверного бандлера. Регион Firestore и авторизованный домен настроены только в Firebase Console (не в коде).

## Тесты перед деплоем

```bash
npm run build && npx playwright test --config=playwright.config.js
```

21/21 должны быть зелёными.
