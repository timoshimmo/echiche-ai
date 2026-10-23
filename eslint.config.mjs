// eslint-config-next 15.x ships legacy (eslintrc) configs only, so they are
// bridged into ESLint 9 flat config with FlatCompat. This matches what
// create-next-app generates for Next 15. Revisit when moving to Next 16,
// whose eslint-config-next exports native flat configs.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "out/**", "build/**", "coverage/**", "worker/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript")
];

export default config;
