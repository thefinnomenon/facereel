import "../src/app.css";
export const metadata = {
  title: "FaceReel",
  description: "Create a face-aligned reel from your photos",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
