import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LifePilot — multi-agent planning assistant',
  description:
    'Describe a real-world goal and watch specialised agents research, cost and ' +
    'schedule it — pausing for your approval before anything consequential.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
