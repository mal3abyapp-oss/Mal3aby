// Entry point -- see server.ts for the actual HTTP control API and
// startup logic. Kept as a thin re-export so `npm run dev`/`npm start`
// have a stable target even if the module is split further later.
import './server.js'
