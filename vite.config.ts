import { defineConfig } from 'vite';

export default defineConfig({
  // health.json is read from the site root at boot; public/ is served there.
  build: { target: 'es2022' },
});
