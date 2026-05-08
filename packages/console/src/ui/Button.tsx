import type React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ok";

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  type?: "button" | "submit" | "reset";
}

export function Button(props: ButtonProps): JSX.Element {
  const { variant = "secondary", type = "button", className, ...rest } = props;
  const mergedClassName = className ? `btn btn-${variant} ${className}` : `btn btn-${variant}`;

  return <button type={type} className={mergedClassName} {...rest} />;
}
