export function ViewFrame({ title, actions, hideHeader = false, children }: { title: string; actions?: React.ReactNode; hideHeader?: boolean; children: React.ReactNode }) {
  return <section id={`view-${title}`} className={`player-main-view react-view ${hideHeader ? 'react-view-no-header' : ''}`} aria-label={hideHeader ? title : undefined}>{!hideHeader && <header className="react-view-header"><div><h1>{title}</h1></div>{actions}</header>}{children}</section>
}
