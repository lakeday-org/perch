import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'urlkit',
  description: 'Parse, build and resolve URLs and query strings.',
  themeConfig: {
    nav: [{ text: 'Guide', link: '/' }, { text: 'API', link: '/api' }],
    sidebar: [
      { text: 'Guide', items: [{ text: 'Getting started', link: '/' }, { text: 'Array formats', link: '/arrays' }] },
      { text: 'API', items: [{ text: 'parse and stringify', link: '/api' }, { text: 'Url', link: '/url' }, { text: 'PathTemplate', link: '/templates' }] },
    ],
  },
});
