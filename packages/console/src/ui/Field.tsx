import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export interface FieldInputProps {
  id: string;
  "aria-describedby"?: string;
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactElement | ((inputProps: FieldInputProps) => ReactNode);
}

export function Field({ label, htmlFor, error, children }: FieldProps): JSX.Element {
  const errorId = `${htmlFor}-error`;

  const inputProps: FieldInputProps = { id: htmlFor };

  if (typeof children === "function") {
    if (error) {
      inputProps["aria-describedby"] = errorId;
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: "var(--fs-12)",
            fontWeight: 500,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </label>
        {children(inputProps)}
        {error && (
          <p
            id={errorId}
            role="alert"
            style={{
              margin: 0,
              fontSize: "var(--fs-12)",
              color: "var(--color-err)",
            }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  if (isValidElement(children)) {
    const child = children as ReactElement<{ "aria-describedby"?: string; id?: string }>;
    const existingDescribedBy = child.props["aria-describedby"];
    const describedByParts: string[] = [];
    if (existingDescribedBy) {
      describedByParts.push(existingDescribedBy);
    }
    if (error) {
      describedByParts.push(errorId);
    }
    inputProps["aria-describedby"] =
      describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: "var(--fs-12)",
            fontWeight: 500,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </label>
        {cloneElement(child, inputProps)}
        {error && (
          <p
            id={errorId}
            role="alert"
            style={{
              margin: 0,
              fontSize: "var(--fs-12)",
              color: "var(--color-err)",
            }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: "var(--fs-12)",
          fontWeight: 500,
          color: "var(--color-text-secondary)",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
