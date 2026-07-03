import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  base: '/',
  define: {
    // Version et date de mise à jour affichées dans l'en-tête,
    // recalculées automatiquement à chaque build/déploiement.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_UPDATED__: JSON.stringify(
      new Date().toLocaleDateString('fr-FR', { timeZone: 'America/Martinique' })
    ),
  },
})
