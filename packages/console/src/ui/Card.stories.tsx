import type { Meta, StoryObj } from '@storybook/react';
import { Card, CardHead } from './Card';
import { Button } from './Button';

const meta: Meta<typeof Card> = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { children: 'Card body content goes here.' },
};

export const WithHead: Story = {
  render: () => (
    <Card>
      <CardHead title="Session summary" />
      <div>content</div>
    </Card>
  ),
};

export const WithHeadAndId: Story = {
  render: () => (
    <Card>
      <CardHead title="Session summary" id="abc123" />
      <div>content</div>
    </Card>
  ),
};

export const WithHeadAndDot: Story = {
  render: () => (
    <>
      <Card>
        <CardHead title="healthy" dot="dot-ok" />
        <div>content</div>
      </Card>
      <br />
      <Card>
        <CardHead title="unhealthy" dot="dot-err" />
        <div>content</div>
      </Card>
    </>
  ),
};

export const WithHeadAndActions: Story = {
  render: () => (
    <Card>
      <CardHead title="active session" actions={<Button variant="ghost">action</Button>} />
      <div>content</div>
    </Card>
  ),
};
