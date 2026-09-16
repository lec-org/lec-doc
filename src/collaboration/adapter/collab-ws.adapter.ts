import { WebSocketServer } from 'ws';
import { LecBrowserSecurity } from '../../core/auth/lec-browser-security';

export class CollabWsAdapter {
  private readonly wss: WebSocketServer;

  constructor(private readonly security: LecBrowserSecurity) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(path: string, httpServer: any) {
    httpServer.on('upgrade', (request: any, socket: any, head: any) => {
      try {
        const baseUrl = 'ws://' + request.headers.host + '/';
        const pathname = new URL(request.url, baseUrl).pathname;

        if (pathname === path) {
          try {
            this.security.assertOrigin(request.headers.origin, true);
          } catch {
            socket.end(
              'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            );
            return;
          }
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request);
          });
        } else if (pathname === '/socket.io/') {
          return;
        } else {
          socket.destroy();
        }
      } catch {
        socket.end(
          'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
    });

    return this.wss;
  }

  public close() {
    try {
      this.wss.close();
    } catch (err) {
      console.error(err);
    }
  }

  public destroy() {
    try {
      this.wss.close();
      this.wss.clients.forEach((client) => {
        client.terminate();
      });
    } catch (err) {
      console.error(err);
    }
  }
}
