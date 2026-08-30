import React, { useState, useEffect } from 'react';
import ContractConfigDashboard from '../../components/admin/ContractConfigDashboard';

interface UserRow {
  id: string;
  address: string;
  status: 'ACTIVE' | 'BANNED';
  createdAt: string;
}

export default function AdminDashboard() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [analytics, setAnalytics] = useState({ totalUsers: 0, totalPrompts: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'users' | 'contract'>('users');

  const authHeaders = (): HeadersInit => {
    const adminToken = localStorage.getItem('adminToken');
    return adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  };

  // Fetch live admin metrics from the configured same-origin API
  useEffect(() => {
    async function fetchAdminMetrics() {
      setLoadError(null);

      if (!localStorage.getItem('adminToken')) {
        setLoadError('Admin authentication required to view this dashboard.');
        setLoading(false);
        return;
      }

      try {
        const [analyticsRes, usersRes] = await Promise.all([
          fetch('/api/v1/admin/analytics', { headers: authHeaders() }),
          fetch('/api/v1/admin/users', { headers: authHeaders() }),
        ]);

        if (analyticsRes.status === 401 || usersRes.status === 401) {
          setLoadError('Your admin session has expired. Please sign in again.');
          setLoading(false);
          return;
        }

        if (!analyticsRes.ok || !usersRes.ok) {
          setLoadError('Unable to load admin data from the server. Please try again later.');
          setLoading(false);
          return;
        }

        const analyticsData = await analyticsRes.json();
        const usersData = await usersRes.json();
        setAnalytics(analyticsData);
        setUsers(usersData);
      } catch (_error) {
        setLoadError('Unable to reach the admin API. Please check your connection and try again.');
      } finally {
        setLoading(false);
      }
    }

    fetchAdminMetrics();
  }, []);

  const handleToggleBan = async (id: string, currentStatus: 'ACTIVE' | 'BANNED') => {
    const nextStatus = currentStatus === 'ACTIVE' ? 'BANNED' : 'ACTIVE';
    setActionError(null);

    try {
      const response = await fetch(`/api/v1/admin/prompts/${id}/moderate`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ action: nextStatus }),
      });

      if (!response.ok) {
        setActionError(`Failed to update status for ${id}: ${response.status} ${response.statusText}`);
        return;
      }

      const updated = await response.json();
      setUsers(users.map(u => u.id === id ? { ...u, status: updated.status ?? nextStatus } : u));
    } catch (error) {
      setActionError(
        `Failed to update status for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  if (loading) return <div style={{ padding: '2rem', color: '#fff' }}>Loading Analytics Matrix...</div>;

  return (
    <div style={{ padding: '2rem', backgroundColor: '#121214', color: '#fff', minHeight: '100vh' } as React.CSSProperties}>
      <h1 style={{ marginBottom: '1.5rem', fontSize: '1.75rem' } as React.CSSProperties}>Admin Control Center</h1>
      
      {/* Tab Switcher */}
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1.5rem', borderBottom: '1px solid #323238', paddingBottom: '0.75rem' } as React.CSSProperties}>
        <button
          onClick={() => setActiveTab('users')}
          style={{
            background: 'transparent',
            border: 'none',
            color: activeTab === 'users' ? '#9061f9' : '#8d8d99',
            fontSize: '1rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            borderBottom: activeTab === 'users' ? '2px solid #9061f9' : 'none',
            paddingBottom: '0.5rem',
            transition: 'all 0.2s',
            outline: 'none'
          } as React.CSSProperties}
        >
          User Management
        </button>
        <button
          onClick={() => setActiveTab('contract')}
          style={{
            background: 'transparent',
            border: 'none',
            color: activeTab === 'contract' ? '#9061f9' : '#8d8d99',
            fontSize: '1rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            borderBottom: activeTab === 'contract' ? '2px solid #9061f9' : 'none',
            paddingBottom: '0.5rem',
            transition: 'all 0.2s',
            outline: 'none'
          } as React.CSSProperties}
        >
          Contract Configuration
        </button>
      </div>

      {activeTab === 'users' ? (
        <>
          {loadError && (
            <div style={{ background: '#3a1a1e', border: '1px solid #aa2834', color: '#ff8a94', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' } as React.CSSProperties}>
              {loadError}
            </div>
          )}
          {actionError && (
            <div style={{ background: '#3a1a1e', border: '1px solid #aa2834', color: '#ff8a94', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' } as React.CSSProperties}>
              {actionError}
            </div>
          )}

          {/* Metrics Row */}
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem' } as React.CSSProperties}>
            <div style={{ background: '#202024', padding: '1.5rem', borderRadius: '8px', minWidth: '150px' } as React.CSSProperties}>
              <p style={{ color: '#8d8d99', fontSize: '0.875rem' } as React.CSSProperties}>Total Users</p>
              <h2 style={{ fontSize: '2rem', margin: '0.5rem 0 0' } as React.CSSProperties}>{loadError ? '—' : analytics.totalUsers}</h2>
            </div>
            <div style={{ background: '#202024', padding: '1.5rem', borderRadius: '8px', minWidth: '150px' } as React.CSSProperties}>
              <p style={{ color: '#8d8d99', fontSize: '0.875rem' } as React.CSSProperties}>Total Prompts Indexed</p>
              <h2 style={{ fontSize: '2rem', margin: '0.5rem 0 0' } as React.CSSProperties}>{loadError ? '—' : analytics.totalPrompts}</h2>
            </div>
          </div>

          {/* User Management Table */}
          <h3 style={{ marginBottom: '1rem' } as React.CSSProperties}>Registered Management Matrix</h3>
          <div style={{ overflowX: 'auto', background: '#202024', borderRadius: '8px' } as React.CSSProperties}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' } as React.CSSProperties}>
              <thead>
                <tr style={{ borderBottom: '1px solid #323238', color: '#c4c4cc' } as React.CSSProperties}>
                  <th style={{ padding: '1rem' }}>Wallet Address</th>
                  <th style={{ padding: '1rem' }}>Joined Date</th>
                  <th style={{ padding: '1rem' }}>Status</th>
                  <th style={{ padding: '1rem', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadError ? (
                  <tr>
                    <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#8d8d99' }}>User data is unavailable.</td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#8d8d99' }}>No users currently registered in index pool.</td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} style={{ borderBottom: '1px solid #323238' } as React.CSSProperties}>
                      <td style={{ padding: '1rem', fontFamily: 'monospace' } as React.CSSProperties}>{user.address}</td>
                      <td style={{ padding: '1rem' } as React.CSSProperties}>{user.createdAt}</td>
                      <td style={{ padding: '1rem' } as React.CSSProperties}>
                        <span style={{ 
                          padding: '0.25rem 0.5rem', 
                          borderRadius: '4px', 
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          background: user.status === 'BANNED' ? '#aa2834' : '#015f43',
                          color: '#fff'
                        } as React.CSSProperties}>
                          {user.status || 'ACTIVE'}
                        </span>
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' } as React.CSSProperties}>
                        <button 
                          onClick={() => handleToggleBan(user.id, user.status)}
                          style={{
                            background: user.status === 'BANNED' ? '#015f43' : '#aa2834',
                            color: '#fff',
                            border: 'none',
                            padding: '0.4rem 0.8rem',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.875rem'
                          } as React.CSSProperties}
                        >
                          {user.status === 'BANNED' ? 'Unban' : 'Ban User'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div style={{ background: '#202024', padding: '2rem', borderRadius: '8px' } as React.CSSProperties}>
          <ContractConfigDashboard />
        </div>
      )}
    </div>
  );
}