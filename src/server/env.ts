import path from 'node:path'

/** Loads optional local secrets (e.g. OPENAI_API_KEY) from `<root>/.env`; a missing file is fine. */
export function loadLocalEnv(root: string) {
  try {
    process.loadEnvFile(path.join(root, '.env'))
  } catch {
    // no .env
  }
}
