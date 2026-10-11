/// <reference types="vite/client" />

// Pulls in Vite's `ImportMetaEnv` augmentation so `import.meta.env.BASE_URL`,
// `MODE`, `DEV`, `PROD`, etc. type-check during `tsc` (and by extension the
// `npm run build` step that the Docker image build runs). Required because
// the standard tsconfig doesn't include vite/client by default.
