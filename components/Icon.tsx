const icons = {
  question: 'M9 9a3 3 0 1 1 5.12 2.12c-1.2 1.2-2.12 1.6-2.12 3.38m0 3.5h.01',
  download: 'M12 3v11m-4-4 4 4 4-4M5 15v5h14v-5',
  delete: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m-4 4 4-4 4 4M5 15v5h14v-5',
  check: 'm5 12.5 4.5 4.5L19 7.5',
};

export default function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={icons[name]} />
    </svg>
  );
}
