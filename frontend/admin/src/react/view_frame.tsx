export function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="view active admin-react-view"><header className="view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}
