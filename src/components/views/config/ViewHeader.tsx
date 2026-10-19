import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Page header shared by the four config views (uses the foundation's .view__header classes). */
export function ViewHeader({ icon: Icon, title, desc, actions }: { icon: LucideIcon; title: string; desc: string; actions?: ReactNode }) {
  return (
    <header className="view__header">
      <div className="view__heading">
        <h1 className="view__title"><Icon size={20} aria-hidden />{title}</h1>
        <p className="view__desc">{desc}</p>
      </div>
      {actions && <div className="view__actions">{actions}</div>}
    </header>
  );
}
