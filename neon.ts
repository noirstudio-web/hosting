// Infraestructura de Noir Studio en la nube (Neon): archivos, base de datos y servidor.
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    noir: {}, // privado: los archivos solo se entregan con enlaces firmados por el servidor
  },
  functions: {
    noir: {
      name: "Noir Studio servidor",
      source: "cloud/function.mjs",
      env: { NOIR_CLOUD: "1" },
    },
  },
});
