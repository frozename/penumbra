export type TabItem = { id: string; label: string };

export interface TabsProps {
  items: readonly TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function Tabs(props: TabsProps): JSX.Element {
  const { items, activeId, onSelect } = props;
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 12,
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === activeId}
          className={`btn ${item.id === activeId ? "btn-primary" : "btn-ghost"}`}
          onClick={() => {
            onSelect(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
