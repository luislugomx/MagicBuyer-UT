English: [README.md](README.md)

# MagicBuyer-UT — sniper para la web app de EA FC 27

Script de Tampermonkey que le agrega un sniper / autobuyer a la web app de **EA SPORTS FC 27 Ultimate Team**:
búsquedas en bucle en el Mercado de transferencias, Comprar ya en las cartas por debajo de tu precio máximo (fijo o
un % del precio de FUTBIN seguido en vivo), publicación automática al precio de FUTBIN, precio de FUTBIN en cada
carta, importación de soluciones de SBC desde FUTBIN con compra de los jugadores que faltan, y pausas y paros configurables.

> ⚠️ **Léelo antes de usarlo.** Automatizar la web app va contra los términos de servicio de EA.
> EA puede restringir tu acceso al Mercado de transferencias (soft ban), pedirte captchas o incluso banear la cuenta.
> Usa este script bajo tu propio riesgo; los autores no se hacen responsables de ninguna sanción en tu cuenta.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en Chrome, Edge o Brave.
   En versiones recientes de Chrome, activa **"Permitir scripts de usuario"** en los detalles de la extensión de Tampermonkey.
2. Abre `fut-auto-buyer.user.js` desde el [último release](https://github.com/AMINE1921/MagicBuyer-UT/releases/latest) y dale clic a **Instalar**.
3. Abre la [web app de FC 27](https://www.ea.com/ea-sports-fc/ultimate-team/web-app/) e inicia sesión.

Tu cuenta debe tener desbloqueado el Mercado de transferencias.

## Inicio rápido

1. Dale clic a la pestaña **MagicBuyer** (barra de navegación de EA) o al botón **MB** abajo a la derecha.
2. Pestaña **Objetivo**: escribe el nombre del jugador y elígelo de la lista.
3. Llena el **Precio máx. de Comprar ya** y, si quieres revender, el **Precio de reventa**
   (el panel muestra el neto después del impuesto de 5% de EA y la ganancia por carta).
4. Dale clic a **Probar búsqueda (sin comprar)** para ver lo que regresa el mercado (en verde: lo que compraría el bot).
5. Dale clic a **▶ Iniciar**. Puedes cerrar el panel: el botón flotante muestra el estado, las búsquedas y las compras.

Otra forma: arma tu búsqueda en **Transferencias → Mercado de transferencias** de EA (rareza, posición, estilo de química…)
y dale clic a **⚡ Snipear esta búsqueda**: se crea un filtro con exactamente esos criterios.

## Idioma

La interfaz está en inglés y español. Elige el idioma en el selector del encabezado del panel:

- **Auto** (predeterminado): sigue el idioma de la web app de EA, luego el de tu navegador, y si no, usa inglés.
- **English** / **Español**: fuerza ese idioma.

Tu elección se guarda junto con el resto de los ajustes.

## Precios de FUTBIN

Todas las funciones de precio usan **FUTBIN** (las páginas se leen igual que en tu navegador, plataforma consola o PC
según tu cuenta). Pestaña **FUTBIN**: el botón **Probar FUTBIN** verifica el acceso.

- **Compra a un % del precio de FUTBIN** (pestaña Objetivo → Precio de compra → Modo): por ejemplo 90%; el precio máximo
  de compra se recalcula en cada actualización del precio. Un precio fijo puede servir como tope absoluto.
  Sin un precio de FUTBIN reciente (de menos de 5 min), el filtro espera: nunca compra con un precio viejo.
- **Reventa a un % del precio de FUTBIN** (pestaña Venta, o por filtro): el precio de la versión comprada se vuelve a leer justo
  después de la compra. Sin precio de FUTBIN, la carta se va a la Lista de transferencias sin publicarse.
- **Republicar al precio de FUTBIN** y el botón **Publicar al precio FUTBIN** (pestaña Transferencias) para las cartas disponibles y no vendidas.
- **Etiqueta de precio** arriba de cada carta de jugador (club, mercado, transferencias, plantillas, SBC); al darle clic abre la página de FUTBIN.
- **Panel "Publicar en el Mercado de transferencias" de EA**: precio de FUTBIN de la carta y botón **Llenar** (tú confirmas con el botón de EA).

Actualización inteligente: los objetivos del bot y las compras de SBC se vuelven a leer cada 60 a 120 s, las cartas
en pantalla cada ~2 min (menos seguido si el precio no se mueve), una sola petición a FUTBIN a la vez, espaciadas,
frenado automático si FUTBIN bloquea, y un salto de precio anormal se verifica una segunda vez antes de usarse.
FUTBIN no empuja sus precios: se vuelven a leer seguido mientras la carta esté en seguimiento.

Si FUTBIN te regresa una verificación de Cloudflare, abre futbin.com en una pestaña y pasa la verificación;
el respaldo de "página oculta de FUTBIN" (iframe invisible) entra al quite cuando la petición directa es rechazada.

## SBC: soluciones de FUTBIN

1. Abre la plantilla de un desafío (la pantalla con la cancha) y dale clic a **⚡ Solución FUTBIN** arriba de la pantalla.
2. Pega el link de la solución de FUTBIN (la página de la plantilla) y luego **Cargar**: formación, 11 jugadores, los de tu club
   (y del almacén de SBC, sin préstamos, primero los intransferibles) y los que hay que **comprar** con su precio de FUTBIN.
3. **Colocar en la plantilla**: se aplica la formación y los jugadores se colocan en una posición donde pueden jugar.
4. Revisa o cambia el **precio máximo** de cada faltante (precio de FUTBIN + margen ajustable) y luego **Comprar los faltantes**:
   búsqueda exacta de la versión, primero la más barata, compra, envío al club y colocación en el desafío.

El desafío nunca se envía solo: tú eres quien le da clic a "Enviar". Un captcha, una sesión expirada o un
límite de EA detienen la compra de inmediato; el botón **Detener** la para en cualquier momento.

## Cómo evita el sniper que se te escape una ganga

- **Resultados frescos en cada búsqueda**: se limpia el caché de la web app y cada petición es distinta
  (anti-caché "automático": la puja máxima varía *por encima* de tu precio máximo de compra, así que no se excluye ningún anuncio comprable).
- **Comprar ya al instante** en cuanto EA responde, sin esperar a FUTBIN ni a ninguna otra petición.
- **Primero la más barata**, y a igual precio la más reciente; tus propios anuncios se ignoran.
- **Reventa después de la compra**, nunca durante: la siguiente búsqueda no se retrasa.
- **Pestaña activa en segundo plano**: Chrome frena las pestañas ocultas; la opción "Mantener la pestaña activa" lo evita
  (aparece un ícono de bocina en la pestaña, pero no suena nada).

## Ajustes

| Pestaña | Ajustes principales |
| --- | --- |
| **Objetivo** | Filtros guardados, rotación entre filtros, jugador, calidad, posición, media mín./máx., precio de compra (fijo o % de FUTBIN en vivo, tope), reventa (pestaña Venta, fijo o % de FUTBIN), puja máxima, IDs avanzados (versión exacta, rareza, nacionalidad, liga, club, estilo de química). |
| **Compra** | Compras máximas por búsqueda, detener después de N compras, reserva de monedas, umbral de resultados, ignorar porteros, pujas (ventana de cierre, superar puja, pujas activas máximas). |
| **Venta** | Publicación automática / mandar a la Lista de transferencias / nada, precio fijo o % del precio de FUTBIN, duración, ganancia mínima. |
| **Tiempos** | Perfiles Prudente / Normal / Rápido, tiempo entre búsquedas, búsquedas máximas por minuto, pausa cada N búsquedas, duración de la pausa, paro automático, espera después de comprar, anti-caché, páginas recorridas, pausa de seguridad por límite de EA. |
| **Transferencias** | Estado de la lista, republicar no vendidas (mismo precio o precio de FUTBIN), publicación masiva al precio de FUTBIN, quitar vendidas, detener si la lista está llena. |
| **FUTBIN** | Prueba de acceso, plataforma de precios, frecuencia de actualización, protección contra saltos de precio, etiquetas en las cartas, ajustes de compras de SBC. |
| **Alertas** | Sonidos, notificaciones del navegador, webhook de Discord, bot de Telegram, elección de los eventos que se notifican. |

Formatos aceptados para duraciones: `5-9` (segundos), `4.5-7`, `40-80S`, `5M`, `1-2H`, `1D`.
Todos los valores se guardan solos (almacenamiento de Tampermonkey).

### Perfiles de timing

| Perfil | Entre búsquedas | Máx. / minuto | Pausa | Paro automático |
| --- | --- | --- | --- | --- |
| Prudente | 8 a 14 s | 6 | 60–120 s cada 12–18 búsquedas | 1–2 h |
| Normal (predeterminado) | 5 a 9 s | 10 | 40–80 s cada 15–25 búsquedas | 2–3 h |
| Rápido | 3 a 5 s | 15 | 30–60 s cada 20–30 búsquedas | 1–1.5 h |

Entre más rápido el ritmo, más pronto EA dispara captchas y límites.

### Seguridad

- **Captcha (458)**, **sesión expirada (401)**, **mercado bloqueado (494)**, **cuenta bloqueada**: paro inmediato + alerta.
- **Demasiadas peticiones (429) / bloqueo temporal (512, 521)**: pausa de seguridad (4 a 8 min por defecto), paro si se repite.
- **3 búsquedas fallidas seguidas**: paro.
- Códigos de error personalizados: pestaña Tiempos → Errores de EA.

El script nunca resuelve captchas: resuélvelo tú en la web app y luego vuelve a arrancar.

## Compilar desde el código fuente

```bash
npm install
npm run build:prod
```

El script se genera en `dist/fut-auto-buyer.user.js` (encabezado de Tampermonkey en `tampermonkey-header.js`).

## Novedades 5.1.1

- SBC: se corrigió la lectura de las soluciones de FUTBIN (la plantilla se lee de los datos de la página, ya no de lo que se ve en pantalla):
  formación, posición exacta de cada jugador como en FUTBIN, posición bloqueada del desafío respetada, precios de la página tomados al momento.

## Novedades 5.1.0

- Compra a un % del precio de FUTBIN por filtro, con el precio seguido en vivo mientras corre el bot (tope opcional).
- Reventa y republicación a un % del precio de FUTBIN, publicación masiva de la Lista de transferencias al precio de FUTBIN.
- Etiqueta de precio de FUTBIN en todas las cartas de jugador y botón "Llenar" en el panel de publicación de EA.
- SBC: importación de una solución de FUTBIN (formación + jugadores del club), compra de faltantes al precio de FUTBIN editable.
- Nueva pestaña FUTBIN (prueba de acceso, actualización inteligente, protección contra saltos de precio).
- Se quitó FUTWIZ: FUTBIN es la única fuente. Los ajustes viejos de "precio de referencia" se convierten automáticamente.

## Novedades 5.0.0

Reescritura completa del motor y la interfaz para FC 27:

- Motor de snipe reescrito sobre las APIs reales de la web app de FC 27 (`UTSearchCriteriaDTO`, `services.Item`), sin reescritura de URLs ni hooks frágiles.
- Corrige que el bot se trabara después de la primera compra, que no se detuviera con captcha, que el precio de FUTBIN reemplazara el precio máximo,
  el anti-caché desactivado en jugadores objetivo, los ajustes que nunca se guardaban y el bucle de renderizado que cargaba el procesador.
- Nuevo panel lateral (la web app sigue usable), botón flotante, log filtrable, exportación a CSV, prueba de búsqueda sin comprar,
  importación de una búsqueda de EA, rotación entre varios filtros, perfiles de timing, pujas, notificaciones de Discord/Telegram.
