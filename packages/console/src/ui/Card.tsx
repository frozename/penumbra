import type React from "react";

export interface CardProps {
  className?: string;
  children: React.ReactNode;
}

export interface CardHeadProps {
  title: string;
  id?: string;
  actions?: React.ReactNode;
  dot?: string;
}

export function Card({ className, children }: CardProps): JSX.Element {
  return <div className={`card${className ? " " + className : ""}`}>{children}</div>;
}

export function CardHead({ title, id, actions, dot }: CardHeadProps): JSX.Element {
  return (
    <div className="card-head">
      <h3>
        {dot && <span className={`dot ${dot}`} />}
        {title}
      </h3>
      <div className="card-head-actions">
        {actions}
        {id && <span className="id">{id}</span>}
      </div>
    </div>
  );
}
