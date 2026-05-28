import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-essentials"],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: async (vite) => vite,
  typescript: { reactDocgen: "react-docgen-typescript" },
  docs: { autodocs: "tag" },
};
export default config;
