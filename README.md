# SoundFlow Card 🎵

**Card Lovelace para Music Assistant — Liquid Glass iOS 26**

---

## ✨ Funcionalidades

- ✅ Deteta automaticamente todos os players do Music Assistant (`mass_player_type: player`)
- ✅ Seletor de fonte de áudio (Apple Music, Spotify, Tidal, Rádio, etc.)
- ✅ Popup de colunas com volume individual
- ✅ Filtro de colunas por grupo (botão ⚙️ Definições)
- ✅ Fila de reprodução (botão ≡)
- ✅ Pesquisa: biblioteca → catálogo do serviço
- ✅ Barra de progresso clicável com seek em tempo real
- ✅ Controlos de volume global (+/- e mute)
- ✅ "Adicionar à biblioteca" (usa media_content_id correto)
- ✅ Rádio ao vivo: oculta pesquisa e barra de progresso
- ✅ Efeito Liquid Glass com blur dinâmico na artwork
- ✅ Mini-player no dashboard com controlos básicos
- ✅ Animações spring iOS 26

---

## 📋 Requisitos

- Home Assistant 2024.6+
- Music Assistant instalado e configurado
- HACS instalado

---

## 🚀 Instalação via HACS

1. Abre o HACS → Frontend
2. 3 pontos → Custom repositories
3. Cola `https://github.com/soundflow-dev/soundflow` → categoria **Lovelace** → Add
4. Encontra **SoundFlow Card** → Download
5. Refresca o browser (`Cmd+Shift+R`)

---

## ⚙️ Configuração

```yaml
type: custom:soundflow-card
```

### Colunas manuais (opcional)
```yaml
type: custom:soundflow-card
speakers:
  - media_player.sala
  - media_player.cozinha
```

---

## 🎙️ Utilização

- **Pill esquerdo** → fonte de áudio (Apple Music, Spotify, etc.)
- **Pill direito** → colunas, volume individual
- **≡** → fila de reprodução
- **⚙** → definições / filtrar por grupo de colunas

---

## 📄 Licença

MIT License
