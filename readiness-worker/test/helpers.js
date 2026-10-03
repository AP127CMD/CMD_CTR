// Minimal stand-in for a KV namespace binding: get (text/json), put, list(prefix).
export function memKV() {
  const m = new Map();
  return {
    m,
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      m.set(key, String(value));
    },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
