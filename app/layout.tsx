import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ארנונה ישראל · Arnona Israel — open municipal tax rates",
  description:
    "כל תעריפי הארנונה בישראל לפי רשות, סוג נכס, אזור ושנה — עם קישור לצו הרשמי. " +
    "Open dataset and free API of Israeli municipal Arnona rates per m², with links to each official order.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const REPO = "https://github.com/mikey641/arnona-israel";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            ארנונה ישראל <span className="muted">Arnona Israel</span>
          </Link>
          <nav>
            <Link href="/">טבלה</Link>
            <Link href="/docs">API</Link>
            <a href={REPO}>GitHub</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <p>
            הנתונים חולצו אוטומטית מצווי הארנונה הרשמיים של הרשויות המקומיות. הצו הרשמי הוא המקור המחייב —
            בדקו תמיד מול הקישור. · Rates are machine-extracted from each authority&apos;s official order; the
            linked order is authoritative.
          </p>
          <p>
            <a href={REPO}>קוד פתוח (MIT)</a> · נתונים CC BY 4.0
          </p>
        </footer>
      </body>
    </html>
  );
}
