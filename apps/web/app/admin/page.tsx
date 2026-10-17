import { notFound } from 'next/navigation';
import { adminOrgs, adminWaitlist } from '../../lib/server/admin-owner';
import { requireUser } from '../../lib/server/session';
import { InviteButton } from './invite-button';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requireUser();
  if (!user.isAdmin) notFound();
  const [entries, orgs] = await Promise.all([adminWaitlist(), adminOrgs()]);
  return (
    <main>
      <h1>Waitlist</h1>
      <table>
        <thead><tr><th>Date</th><th>Name</th><th>Email</th><th>Brand</th><th>Category</th><th>Country</th><th>Status</th><th /></tr></thead>
        <tbody>
          {entries.map((w) => (
            <tr key={w.id}>
              <td>{w.createdAt.toISOString().slice(0, 10)}</td><td>{w.name}</td><td>{w.email}</td><td>{w.brand}</td>
              <td>{w.category}</td><td>{w.country}</td><td>{w.status}</td>
              <td>{w.status === 'new' && <InviteButton waitlistId={w.id} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h1>Orgs</h1>
      <table>
        <thead><tr><th>Name</th><th>Members</th><th>Created</th></tr></thead>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}><td>{o.name}</td><td>{o.members}</td><td>{o.createdAt.toISOString().slice(0, 10)}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
