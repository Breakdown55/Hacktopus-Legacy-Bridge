import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import ProjectProvider from '@/components/ProjectProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Legacy Bridge',
  description: 'Legacy Bridge project workspace',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><ProjectProvider>{children}</ProjectProvider></body>
    </html>
  );
}
