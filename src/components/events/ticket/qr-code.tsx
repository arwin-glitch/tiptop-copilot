import QRCode from 'qrcode';

/**
 * A QR code as an inline SVG drawn from React elements (D-075): the module
 * matrix from `qrcode`, one path, no HTML strings and no image request.
 * Render it on the server (the library stays out of the guest's bundle) and
 * pass the element to client components as a prop.
 */

export function qrPath(text: string): { size: number; d: string } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && data[y * size + x + run]) run++;
      d += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return { size: size + 8, d };
}

export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { size, d } = qrPath(value);
  return (
    <svg
      className={className ?? 'evu-qr'}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
