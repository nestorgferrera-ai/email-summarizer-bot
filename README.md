# 📧 Email Summarizer Bot

Resume automático de correos Ionos enviados por Telegram cada mañana a las 07:00.

## 🚀 Características

- ✅ Lee correos desde Ionos IMAP
- ✅ Resume con Claude API
- ✅ Envía por Telegram a las 07:00 (horario España)
- ✅ Busca correos desde las 07:00 del día anterior hasta las 07:00 del día actual
- ✅ Gratuito en Render.com

## 📋 Requisitos previos

1. **Cuenta Render.com** (gratuita): https://render.com
2. **Clave Claude API**: https://console.anthropic.com/account/keys
3. **Telegram Bot Token** (ya tienes): `8717852588:AAFW6QgY8TNlpkwxhO7qqMWOm9xz2fnJEiY`
4. **Chat ID Telegram** (ya tienes): `1771192684`

## 🔧 Instalación Local (para testing)

```bash
# 1. Descargar los archivos
# Necesitas: email-bot-server.js, package.json, .env

# 2. Instalar dependencias
npm install

# 3. Configurar .env
# Edita el archivo .env y añade tu CLAUDE_API_KEY

# 4. Ejecutar
npm start

# 5. Testing: enviar resumen manualmente
curl -X POST http://localhost:3000/trigger
```

## 🌍 Despliegue en Render.com (RECOMENDADO)

### Paso 1: Crear repositorio GitHub

```bash
# Crear carpeta y repositorio
mkdir email-summarizer-bot
cd email-summarizer-bot
git init

# Copiar archivos
# - email-bot-server.js
# - package.json
# - .env (sin credenciales, solo variables)
# - Procfile
# - .gitignore
# - README.md (este archivo)

# Crear repositorio en GitHub
# Ir a https://github.com/new
# Nombre: email-summarizer-bot
# Descripción: Resume correos Ionos y envía por Telegram

# Subir código
git add .
git commit -m "Initial commit: Email summarizer bot"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/email-summarizer-bot.git
git push -u origin main
```

### Paso 2: Conectar Render.com

1. Ir a https://render.com/dashboard
2. Click en **New +** → **Web Service**
3. Seleccionar **Connect a repository**
4. Buscar y conectar: `email-summarizer-bot`
5. Configurar el servicio:
   - **Name**: `email-summarizer-bot`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free` (Starter)

### Paso 3: Configurar Variables de Entorno

En el dashboard de Render, ir a **Environment** y añadir:

```
CLAUDE_API_KEY = sk-ant-... (tu clave Claude)
```

### Paso 4: Deploy

Render automáticamente deployará cuando hagas push a main.

```bash
git push origin main
```

Esperar ~2 minutos a que se complete el deploy.

## ✅ Verificar que funciona

### Check 1: Health Check
```bash
curl https://email-summarizer-bot.onrender.com/
```

Respuesta esperada:
```json
{
  "status": "online",
  "service": "Email Summarizer Bot",
  "scheduled": "07:00 diariamente"
}
```

### Check 2: Estado detallado
```bash
curl https://email-summarizer-bot.onrender.com/status
```

### Check 3: Trigger manual (testing)
```bash
curl -X POST https://email-summarizer-bot.onrender.com/trigger
```

Deberías recibir un mensaje en Telegram en ~10 segundos.

## 🔧 Solucionar problemas

### "Error: CLAUDE_API_KEY no está configurada"
- Ve a Render dashboard → Settings → Environment
- Verifica que CLAUDE_API_KEY esté bien configurada
- Redeploy: en el dashboard, **Manual Deploy** → **Clear build cache and deploy**

### "No se conecta a Ionos IMAP"
- Verifica que usuario/contraseña sean correctos
- Comprueba que Ionos no tenga bloqueada la conexión IMAP
- Intenta manualmente: `telnet imap.ionos.com 993`

### "No envía a Telegram"
- Verifica el token y chat_id
- Prueba el token: `curl https://api.telegram.org/botTOKEN/getMe`

### El bot no se ejecuta a las 07:00
- Render usa UTC por defecto
- El código ajusta a horario España (CET/CEST)
- Los logs aparecen en el dashboard de Render
- En el tab **Logs** puedes ver si se ejecutó

## 📝 Logs y Monitoreo

Los logs aparecen en tiempo real en Render dashboard:
- **Info**: conexiones exitosas, correos procesados
- **Errores**: problemas con IMAP, Claude API, Telegram

Cada ejecución registra:
```
🚀 Iniciando resumen diario...
✅ Conectado a Ionos IMAP
📧 Se encontraron X correos
✅ Resumen generado por Claude
✅ Mensaje enviado por Telegram
```

## 🛠️ Personalizaciones

### Cambiar hora de ejecución

En `email-bot-server.js`, línea ~30:
```javascript
summary_hour: 7,      // cambiar a tu preferencia (0-23)
summary_minute: 0,    // minuto exacto
range_hour: 7         // la hora del rango (desde esta hora del día anterior)
```

Para las 08:00:
```javascript
summary_hour: 8,
summary_minute: 0,
range_hour: 8         // buscaría desde las 08:00 del día anterior
```

### Cambiar rango de correos

El rango automático es desde las 07:00 del día anterior hasta las 07:00 del día actual.

Para modificarlo, edita en `fetchEmailsFromToday()`:
```javascript
const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 7, 0, 0);
const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0);
// Cambiar el 7 a la hora que prefieras
```

### Ajustar prompt de Claude

En `summarizeEmailsWithClaude()`, ajusta el contenido del `prompt` según tus necesidades.

## 💡 Tips

1. **Free tier de Render**: El servidor se "duerme" después de 15 minutos sin uso. A las 07:00 se despierta automáticamente.
2. **Historial**: Los logs se guardan en Render, accesibles desde el dashboard.
3. **Upgrades**: Si necesitas mayor disponibilidad, Render ofrece planes de pago desde $7/mes.

## 📞 Soporte

Si algo no funciona:

1. Revisa los **Logs** en Render dashboard
2. Verifica las credenciales en el archivo `.env`
3. Ejecuta `/trigger` manualmente para testear
4. Comprueba conectividad IMAP a Ionos

---

**Hecho para Clínica Bandama | Nestor Garcia**
