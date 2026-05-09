import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'UI/Badge',
  component: Badge,
  tags: ['autodocs'],
  args: { children: 'pending' },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Ok:    Story = { args: { variant: 'ok',    children: 'completed' } };
export const Warn:  Story = { args: { variant: 'warn',  children: 'concerns' } };
export const Err:   Story = { args: { variant: 'err',   children: 'failed' } };
export const Info:  Story = { args: { variant: 'info',  children: 'in-progress' } };
export const Brand: Story = { args: { variant: 'brand', children: 'maestro' } };
export const Muted: Story = { args: { variant: 'muted', children: '—' } };
