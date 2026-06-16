# KickIRL 🌍📸

O **KickIRL** é um sistema avançado de rastreamento de localização GPS (Global Positioning System) em tempo real, construído exclusivamente para streamers "In Real Life" (IRL) das plataformas Kick e Twitch. 

O projeto permite que os espectadores acompanhem o trajeto exato do streamer no mapa de forma contínua e suave, com integração direta na live via OBS Studio e um portal global interativo.

### 🌟 Destaques do Projeto

*   **Roteamento Inteligente às Ruas (Road Snapping):** O trajeto percorrido no mapa é alinhado automaticamente à malha de ruas e avenidas usando a API do OSRM (Open Source Routing Machine). Isso evita que a linha de trajeto atravesse edifícios ou quarteirões em linha reta.
*   **Suporte Multiplataforma:** Integração dinâmica de players de stream e botões de ação customizados para **Kick**, **Twitch** e **YouTube**.
*   **Grupo Seleto de Streamers:** Desenvolvido inicialmente para atender a um grupo seleto de streamers (`gabepeixe`, `loud_coringa`, `loud_caiox` e `brabox`), com arquitetura planejada para expansão futura para novos criadores.
*   **Modo Offline Temporário com Auto-Cleanup:** Quando o streamer encerra a live ou o sinal cai, seu pino fica cinza (faded) no mapa imediatamente, indicando o status offline. Caso ele permaneça desconectado por mais de 5 minutos, o marcador e o seu trajeto correspondente são removidos automaticamente do mapa para manter a interface limpa.
*   **Zonas de Segurança (Safe Zones):** Ocultação de localização automática baseada em raio geográfico para proteger a privacidade residencial do streamer.

---

## 🏗️ Arquitetura do Sistema

O sistema é formado por **4 módulos** interconectados:

1. **Backend Server (Node.js + WebSockets):**
   - O cérebro do projeto. Mantém conexões WebSocket abertas com todos os mapas web, recebe disparos de GPS da extensão/app via API REST e gerencia o status `isLive` de cada streamer.
2. **Web Viewer Global (Google Maps API):**
   - Um mapa global web construído com Google Maps (Estilo Dark Mode Invertido) que mostra **todos os streamers ao vivo simultaneamente**, sem precisar de login. Ideal para espectadores "caçarem" streams IRL.
3. **Overlay para OBS Studio:**
   - Uma fonte de navegador (Browser Source) transparente desenhada em estilo *Premium/Glassmorphism* que o streamer coloca no OBS. Ela puxa automaticamente a foto de perfil da API pública da Kick e mostra a localização em uma mini-janela no canto da tela do vídeo.
4. **Emissores de GPS (Mobile & Desktop):**
   - **Aplicativo Mobile (React Native / Expo):** Criado para o streamer que está caminhando na rua transmitir os dados brutos do satélite (precisão de ~3m) com a tela do celular sempre ligada.
   - **Web App (PWA) e Extensão Chrome:** Alternativas rápidas de tracking em background utilizando WakeLock para não perder o rastreamento se o navegador for minimizado.

---

## 🚀 Como Rodar o Servidor (Local)

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Inicie o servidor:
   ```bash
   npm start
   ```
3. O servidor abrirá na porta `3000`. 
   - Painel Global: `http://localhost:3000/`
   - Teste PWA Mobile: `http://localhost:3000/tracker.html`

---

## ☁️ Deploy na Nuvem (Render.com)

Este projeto está pré-configurado para rodar no plano gratuito do **Render**.

1. Crie um `Web Service` no Render.com.
2. Aponte para este repositório do GitHub (`BrunoSilva77/kickirl-backend`).
3. O Render instalará os pacotes e inicializará o servidor.
4. **Atenção:** Em servidores efêmeros (planos grátis), a pasta `data/` será limpa sempre que o servidor dormir, exigindo que os streamers se reconectem. Para persistência de longo prazo, utilize um banco de dados ou migre para uma VPS dedicada.

---

## 📡 Rotas da API REST

- `POST /api/register` - Registra um canal da Kick e devolve chaves de transmissão exclusivas.
- `POST /api/push?key=XXX` - Recebe os dados de Latitude e Longitude do rastreador do streamer.
- `POST /api/stop?key=XXX` - Kill-switch. Tira o streamer imediatamente do ar.
- `GET /api/pull?key=XXX` - Rota de polling para o painel do OBS puxar os dados.

---

**Desenvolvido com 💚 por Bruno Silva.**

*   🔗 **GitHub:** [github.com/BrunoSilva77](https://github.com/BrunoSilva77)
*   🔗 **LinkedIn:** [linkedin.com/in/bruno-h-silva2025](https://www.linkedin.com/in/bruno-h-silva2025/)
