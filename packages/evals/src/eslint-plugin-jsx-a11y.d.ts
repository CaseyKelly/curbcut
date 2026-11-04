// eslint-plugin-jsx-a11y ships no types; scorer (b) only uses its strict config.
declare module 'eslint-plugin-jsx-a11y' {
  import type { Linter } from 'eslint';

  const plugin: { flatConfigs: { strict: Linter.Config } };
  export default plugin;
}
