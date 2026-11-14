import { useEffect, useRef, type ReactNode } from 'react';

export default function Modal({ open, onClose, children, wide, replay }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean; replay?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={replay ? 'modal replay-modal' : wide ? 'modal wide' : 'modal'} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && children}
    </dialog>
  );
}
