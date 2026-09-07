import type { Meta, StoryObj } from "@storybook/react";

import { useEffect } from "react";

import { ToastProvider, useToast } from "./Toast";

const meta: Meta<typeof ToastProvider> = {
  title: "UI/Toast",
  component: ToastProvider,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof meta>;

function ErrorToastStory() {
  const toast = useToast();
  useEffect(() => {
    toast.push({ kind: "error", text: "handoff_conflict detected" });
  }, [toast]);
  return null;
}

function InfoToastStory() {
  const toast = useToast();
  useEffect(() => {
    toast.push({ kind: "info", text: "Chain started successfully" });
  }, [toast]);
  return null;
}

export const ErrorToast: Story = {
  render: () => <ErrorToastStory />,
};

export const InfoToast: Story = {
  render: () => <InfoToastStory />,
};
