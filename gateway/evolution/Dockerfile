# Evolution API v2.3.7 + parche de vinculación de WhatsApp.
#
# Por que existe esta imagen:
#   El 2026-07-28 WhatsApp agrego la etapa `companion_reg_refresh` al registro
#   de dispositivos companeros. Baileys la reconoce y la descarta, asi que
#   `pair-success` nunca se emite: la instancia se queda en `connecting` y el
#   telefono muestra "no se pudo vincular". No hay release publicado de Baileys
#   que lo corrija (rc.13, rc.14 y master estan afectados).
#
#   El parche es el de evolution-foundation/evolution-api#2727, que compila:
#     - WhiskeySockets/Baileys#2765  companion_reg_refresh  -> restaura el vinculo
#     - WhiskeySockets/Baileys#2602  link_code_companion_reg -> evita "Invalid buffer"
#
# Sin este parche, QR y codigo de emparejamiento fallan igual. Ver #2696.
#
# Si algun dia Baileys publica el arreglo: subir la imagen base a la version que
# lo traiga y borrar el parche. El build falla en vez de degradar en silencio.

FROM evoapicloud/evolution-api:v2.3.7

USER root
WORKDIR /evolution

COPY baileys+7.0.0-rc14.patch /tmp/baileys.patch

RUN set -eux; \
    apk add --no-cache patch; \
    npm install --no-save --ignore-scripts --no-audit --no-fund baileys@7.0.0-rc14; \
    mkdir -p /evolution/patches; \
    cp /tmp/baileys.patch /evolution/patches/baileys+7.0.0-rc14.patch; \
    cd /evolution; \
    patch -p1 --dry-run < /tmp/baileys.patch; \
    patch -p1 < /tmp/baileys.patch; \
    node -e "const p=require('/evolution/node_modules/baileys/package.json'); if(p.version!=='7.0.0-rc14'){ throw new Error('version inesperada: '+p.version); } console.log('baileys instalado:', p.version);"; \
    test "$(grep -c 'companion_reg_refresh' /evolution/node_modules/baileys/lib/Socket/socket.js)" -gt 0; \
    test "$(grep -c 'primary_identity_pub' /evolution/node_modules/baileys/lib/Socket/messages-recv.js)" -gt 0; \
    test "$(grep -c 'handleCompanionRegRefresh' /evolution/node_modules/baileys/lib/Utils/companion-reg-client-utils.js)" -gt 0; \
    test "$(grep -c 'handleCompanionRegRefresh' /evolution/node_modules/baileys/lib/Socket/socket.js)" -gt 0; \
    echo 'parche verificado: companion_reg_refresh + primary_identity_pub + handleCompanionRegRefresh'

# La imagen base define ENTRYPOINT/CMD; se heredan sin cambios.
