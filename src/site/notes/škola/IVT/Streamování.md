---
{"dg-publish":true,"permalink":"/skola/ivt/streamovani/","dg-note-properties":{}}
---


## Úvod

znamená přehrávat obsah průběžně, zatím co se stahuje

- používáme ho každý den i když si to zrovna neuvědmujeme
- můžeme ho potkat ve formě
	- streamování na vyžádání - to je běžný konzumencký obash např. YouTube nebo Netflix
	- živý přenos - Twitch, sportovní přenosy
	- videohovory - Discord, Whats-app
- Beze streamování by všechna videa fungovali tou formou že si je uživatel musí stáhnout celé před předehráním a videohovory by neexistovaly vůbec.

## Jak to celé funguje?

- před odesláním se video rozdělí na segmenty a ty si pak přehrávač postupně stahuje do vyrovnávací paměti tzv. bufferu.
- Adaptivní kvalita znamená že při zhoršení internetového připojení přehrávače, se kvalita přijatého segmentu zhorší aby se zmenšila odezva. Využívá se například u videohovorů.
- komprese slouží k odlehčení videa, kdyby videa komprese nepoužívala a videa by byla pouze z obrázku byla by obrovská. Proto jsou kodeky které převádějí pixely do vektorů a dokážou matematicky video odlehčit jako např. H. 264 AV1
- CDN tedy síť serverů po světě zaručuje to aby při jakémkoli výpadku sítě se stream dostal do zařízení a zamezil vytížení jednoho serveru.
- Živý přenos má větší buffer tedy má větší spoždění narozdíl od videohovorů které si to nemůžou dovolit.

## Problémy

- vyšší kvality videí mají větší spotřebu energií na oboje strany jak na přijímajícího tak i na vysílajícího. Proto streaming má i přesah do ekologie.