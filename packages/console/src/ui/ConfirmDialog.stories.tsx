import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { ConfirmDialog, ConfirmDialogProvider } from "./ConfirmDialog";

const meta: Meta<typeof ConfirmDialog> = {
  title: "UI/ConfirmDialog",
  component: ConfirmDialog,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <ConfirmDialogProvider>
        <Story />
      </ConfirmDialogProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    open: true,
    title: "Approve handoff",
    onConfirm: () => {},
    onCancel: () => {},
  },
};

export const WithTypedTarget: Story = {
  args: {
    open: true,
    title: "Delete agent",
    typedTarget: "agent/abc",
    onConfirm: () => {},
    onCancel: () => {},
  },
};

function ReasonFilledStory() {
  useEffect(() => {
    const textarea = document.querySelector(
      'textarea[aria-label="Reason"]',
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "I reviewed the changes and they look good");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, []);
  return <ConfirmDialog open title="Approve handoff" onConfirm={() => {}} onCancel={() => {}} />;
}

export const ReasonFilled: Story = {
  render: () => <ReasonFilledStory />,
};
