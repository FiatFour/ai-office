import { Component, type ReactNode, useEffect, useState } from 'react';
import type { Loaded, Route } from './screens.ts';

const ScreenError = ({ id, error }: { id: string; error: string }) => (
  <main data-screen={id} data-screen-error role="alert" style={{ padding: 24, color: '#15181c', background: '#fff' }}>
    {error}
  </main>
);

class Boundary extends Component<{ id: string; children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override componentDidCatch(error: unknown) {
    console.error(`screen ${this.props.id}: failed to render: ${error instanceof Error ? error.message : error}`);
  }
  override render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <ScreenError id={this.props.id} error={`screen ${this.props.id}: failed to render: ${this.state.error}`} />
    );
  }
}

/** Shows one screen. Its wrapper is `[data-screen=<id>]`, the default ready selector of the gates. A screen that does not load shows its cause here and nowhere else. */
export const ScreenHost = ({ route }: { route: Route }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    setLoaded(null);
    route.load().then((result) => {
      if (!result.ok) console.error(result.error);
      if (live) setLoaded(result);
    });
    return () => {
      live = false;
    };
  }, [route]);
  if (loaded === null) return null;
  if (!loaded.ok) return <ScreenError id={route.id} error={loaded.error} />;
  const { screen } = loaded;
  return (
    <Boundary id={route.id}>
      <div
        data-screen={route.id}
        data-ready={screen.ready}
        data-contrast-allow={screen.contrastAllow === undefined ? undefined : JSON.stringify(screen.contrastAllow)}
        style={{ display: 'contents' }}
      >
        <screen.Component />
      </div>
    </Boundary>
  );
};
