import type { Preview } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../src/themes/tokens.css';
import '../src/themes/colors_and_type.css';
import '../src/themes/app.css';

import { useDaemonStore } from '../src/stores/daemon-store';
useDaemonStore.setState({ baseUrl: '/api', token: '', health: 'ok', lastHealthAt: 0 });

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: 'sirius',
      values: [
        { name: 'sirius',  value: 'var(--color-bg)' },
        { name: 'surface', value: 'var(--color-surface)' },
      ],
    },
  },
  decorators: [
    (Story) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <div data-theme="sirius" style={{ padding: 24 }}>
              <Story />
            </div>
          </MemoryRouter>
        </QueryClientProvider>
      );
    },
  ],
};
export default preview;
