"""Geocodificador determinístico para testes: nada de rede."""
import hashlib

from app.geocodificacao import Resultado


class GeocodificadorFalso:
    chamadas = 0

    def buscar(self, endereco: str) -> Resultado:
        GeocodificadorFalso.chamadas += 1
        texto = endereco.lower()
        if "inexistente" in texto:
            return Resultado(encontrado=False)
        h = int(hashlib.sha256(texto.encode()).hexdigest()[:8], 16)
        lat = -15.70 - (h % 2500) / 10000  # dentro do DF
        lng = -47.80 - (h // 2500 % 2500) / 10000
        if "bairro" in texto:
            return Resultado(True, lat, lng, "baixa", "bairro", f"Bairro aproximado: {endereco}")
        return Resultado(True, lat, lng, "alta", "endereco", f"Endereço: {endereco}")
