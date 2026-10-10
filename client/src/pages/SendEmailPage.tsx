/**
 * Send Email page for testing outbound email via Robin's queue API.
 */

import { useState, useEffect } from 'react';
import { Send, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import { robinConfigApi } from '../api/client';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';

interface SendEmailForm {
  mail: string;
  rcpt: string;
  subject: string;
  message: string;
  ehlo: string;
  mx: string;
  port: number;
  tls: boolean;
}

interface ClientConfig {
  mail?: string;
  rcpt?: string[];
  ehlo?: string;
  mx?: string[];
  port?: number;
  tls?: boolean;
}

export function SendEmailPage() {
  const { selectedRobinService } = useServices();
  const [form, setForm] = useState<SendEmailForm>({
    mail: '',
    rcpt: '',
    subject: 'Test email from Robin Admin',
    message: 'This is a test email sent via Robin Admin.\n\nHello World!',
    ehlo: '',
    mx: '',
    port: 25,
    tls: true,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);

  // Load client config defaults
  useEffect(() => {
    loadDefaults();
  }, []);

  const loadDefaults = async () => {
    setIsLoading(true);
    try {
      const res = await robinConfigApi.get('default', 'client.json5');
      if (res.data) {
        const clientConfig = res.data.config as ClientConfig;
        setForm(prev => ({
          ...prev,
          mail: clientConfig.mail || prev.mail,
          rcpt: clientConfig.rcpt?.join(', ') || prev.rcpt,
          ehlo: clientConfig.ehlo || prev.ehlo,
          mx: clientConfig.mx?.join(', ') || prev.mx,
          port: clientConfig.port ?? prev.port,
          tls: clientConfig.tls ?? prev.tls,
        }));
      }
    } catch {
      // Use defaults if config not found
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (field: keyof SendEmailForm, value: string | number | boolean) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setSuccess('');
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSending(true);
    setSuccess('');
    setError('');
    setResponse(null);

    // Build case payload
    const casePayload = {
      serviceId: selectedRobinService?.serviceId ?? null,
      mx: form.mx.split(',').map(s => s.trim()).filter(Boolean),
      port: form.port,
      tls: form.tls,
      ehlo: form.ehlo || undefined,
      envelopes: [
        {
          mail: form.mail,
          rcpt: form.rcpt.split(',').map(s => s.trim()).filter(Boolean),
          subject: form.subject,
          message: form.message,
        },
      ],
    };

    try {
      // Use Robin's /client/queue endpoint via our backend.
      const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
      const response = await fetch(`${apiBase}/robin/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(casePayload),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send email');
      }
      
      setResponse(data);
      setSuccess('Email queued successfully!');
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Failed to send email');
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  if (!selectedRobinService) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.deliveryTest}
          title="Robin delivery test"
          description="Select an enabled Robin service from Fleet before queueing a delivery test."
          actions={<PageServiceSelector serviceType="robin" capability="deliveryTest" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Robin service is currently selected.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.deliveryTest}
        title="Robin delivery test"
        description={`Queue a test message through ${selectedRobinService?.name ?? 'Robin'} using a custom envelope, message body, and delivery target.`}
        actions={
          <>
            <PageServiceSelector serviceType="robin" capability="deliveryTest" />
            <button
              onClick={loadDefaults}
              className="btn btn-secondary"
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Load defaults
            </button>
          </>
        }
      />

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 p-4 rounded-lg mb-6 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 p-4 rounded-lg mb-6 flex items-center gap-2">
          <CheckCircle className="w-5 h-5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Envelope & Message</h3>
            </div>
            <div className="card-body space-y-4">
              <div>
                <label htmlFor="delivery-test-mail-from" className="form-label">Mail from</label>
                <input
                  id="delivery-test-mail-from"
                  type="email"
                  value={form.mail}
                  onChange={(e) => handleChange('mail', e.target.value)}
                  placeholder="sender@example.com"
                  className="form-input"
                  required
                />
                <p className="form-hint">Sender email address (MAIL FROM)</p>
              </div>
              <div>
                <label htmlFor="delivery-test-recipients" className="form-label">Recipients</label>
                <input
                  id="delivery-test-recipients"
                  type="text"
                  value={form.rcpt}
                  onChange={(e) => handleChange('rcpt', e.target.value)}
                  placeholder="recipient1@example.com, recipient2@example.com"
                  className="form-input"
                  required
                />
                <p className="form-hint">Comma-separated list of recipient addresses (RCPT TO)</p>
              </div>
              <div>
                <label htmlFor="delivery-test-subject" className="form-label">Subject</label>
                <input
                  id="delivery-test-subject"
                  type="text"
                  value={form.subject}
                  onChange={(e) => handleChange('subject', e.target.value)}
                  placeholder="Test email subject"
                  className="form-input"
                  required
                />
              </div>
              <div>
                <label htmlFor="delivery-test-message" className="form-label">Message body</label>
                <textarea
                  id="delivery-test-message"
                  value={form.message}
                  onChange={(e) => handleChange('message', e.target.value)}
                  placeholder="Email message body..."
                  className="form-input font-mono"
                  rows={12}
                  required
                />
                <p className="form-hint">Plain text email body</p>
              </div>
            </div>
          </div>

          <div className="card h-fit">
            <div className="card-header">
              <h3 className="card-title">Delivery settings</h3>
            </div>
            <div className="card-body space-y-4">
              <div>
                <label htmlFor="delivery-test-mx" className="form-label">MX Servers</label>
                <input
                  id="delivery-test-mx"
                  type="text"
                  value={form.mx}
                  onChange={(e) => handleChange('mx', e.target.value)}
                  placeholder="127.0.0.1, mail.example.com"
                  className="form-input"
                />
                <p className="form-hint">Comma-separated list of mail servers</p>
              </div>
              <div>
                <label htmlFor="delivery-test-port" className="form-label">Port</label>
                <input
                  id="delivery-test-port"
                  type="number"
                  value={form.port}
                  onChange={(e) => handleChange('port', parseInt(e.target.value) || 25)}
                  min={1}
                  max={65535}
                  className="form-input"
                />
                <p className="form-hint">SMTP port (25, 465, 587)</p>
              </div>
              <div>
                <label htmlFor="delivery-test-ehlo" className="form-label">EHLO Domain</label>
                <input
                  id="delivery-test-ehlo"
                  type="text"
                  value={form.ehlo}
                  onChange={(e) => handleChange('ehlo', e.target.value)}
                  placeholder="example.com"
                  className="form-input"
                />
                <p className="form-hint">Domain to use in EHLO command</p>
              </div>
              <div>
                <label className="form-label">TLS</label>
                <div className="mt-2">
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.tls}
                      onChange={(e) => handleChange('tls', e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-hidden peer-focus:ring-4 peer-focus:ring-robin-orange/20 dark:peer-focus:ring-robin-orange/30 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:rtl:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:inset-s-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-robin-orange"></div>
                    <span className="ms-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                      {form.tls ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
                <p className="form-hint mt-1">Use STARTTLS when available</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSending}
          >
            {isSending ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send email
              </>
            )}
          </button>
        </div>
      </form>

      {response && (
        <div className="card mt-6">
          <div className="card-header">
            <h3 className="card-title">Response</h3>
          </div>
          <div className="card-body">
            <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto text-sm font-mono">
              {JSON.stringify(response, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
