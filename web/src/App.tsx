import { useCallback, useEffect, useState } from 'react';
import { RoomPage } from './RoomPage.js';
import { RoomPicker } from './RoomPicker.js';
import { loadIdentity, rememberRoom, type Identity } from './identity.js';
import { parseRoute, roomPath, type Route } from './routing.js';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [identity, setIdentity] = useState<Identity>(loadIdentity);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);

  useEffect(() => {
    if (route.page === 'room') {
      rememberRoom(route.roomId);
      document.title = `${route.roomId} · Strand`;
    } else {
      document.title = 'Strand';
    }
  }, [route]);

  if (route.page === 'room') {
    return <RoomPage key={route.roomId} roomId={route.roomId} identity={identity} onIdentity={setIdentity} onLeave={() => go('/')} />;
  }
  return <RoomPicker onOpen={(roomId) => go(roomPath(roomId))} />;
}
