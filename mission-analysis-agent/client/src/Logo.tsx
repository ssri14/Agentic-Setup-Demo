export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2 28 9v14l-12 7-12-7V9z" fill="none" stroke="#7fb0ff" strokeWidth="2" />
      <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#7fb0ff" />
    </svg>
  );
}
