import type { Meta, StoryObj } from "@storybook/react";

import { useState } from "react";

import { Drawer } from "./Drawer";

const meta: Meta<typeof Drawer> = {
  title: "UI/Drawer",
  component: Drawer,
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof meta>;

function OpenDrawer() {
  const [open, setOpen] = useState(true);
  return (
    <Drawer
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      title="Drawer title"
    >
      <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
        This is the drawer body content.
      </p>
    </Drawer>
  );
}

function ClosedDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open drawer
      </button>
      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Drawer title"
      >
        <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
          This is the drawer body content.
        </p>
      </Drawer>
    </div>
  );
}

export const Open: Story = {
  render: () => <OpenDrawer />,
};

export const Closed: Story = {
  render: () => <ClosedDrawer />,
};
