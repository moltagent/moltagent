[English](../README.md) | **Deutsch** | [Português](README.pt.md)

---

> ℹ️ **Übersetzungshinweis:** Maßgeblich ist die [englische README](../README.md). Diese Übersetzung wird von Hand gepflegt und kann dem Original hinterherhinken — bei Abweichungen gilt die englische Fassung.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="../assets/logo-light.png">
    <img alt="Moltagent" src="../assets/logo-light.png" height="200">
  </picture>
</p>

# Moltagent

**Souveräne KI-Agenten-Plattform auf Nextcloud-Basis.**

Dein KI-Mitarbeiter. Deine Infrastruktur. Deine Regeln.

[![CI](https://github.com/moltagent/moltagent/actions/workflows/test.yml/badge.svg)](https://github.com/moltagent/moltagent/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

<p align="center">
  <a href="https://public.moltagent.cloud">
    <img src="../assets/architecture-preview.png" alt="Moltagent-Architektur" width="800">
  </a>
</p>
<p align="center"><em>Live-Architektur unter <a href="https://public.moltagent.cloud">public.moltagent.cloud</a></em></p>

---

> ⚠️ **Status: Beta. Gebaut für unseren Gebrauch, geteilt mit dir.**
> 
> Moltagent läuft in Produktion für seinen Schöpfer. Ich nutze ihn täglich für Content-Workflows, Wissensmanagement und redaktionelle Abläufe. Aber die Architektur entwickelt sich noch, und einige Funktionen sind noch teilweise umgesetzt.
> 
> Der `main`-Branch ist das, was wir in Produktion laufen lassen. Der `next`-Branch ist die aktive Entwicklung. Rechne mit Breaking Changes auf `next`.
> 
> Es fehlt der Feinschliff. Es ist ein funktionierendes System, das ich teile, weil ich glaube, dass souveräne KI-Infrastruktur Open Source sein sollte.
> 
> **Wie das entwickelt wird:** Der gesamte Codebase entsteht in Zusammenarbeit mit Claude (Anthropic). Ein Mensch (ich) definiert die Architektur, schreibt Briefings, trifft Design-Entscheidungen, rezensiert jeden Commit und testet in Produktion. Claude setzt um. Jede Funktion beginnt als schriftliche Spezifikation, nicht als Prompt. Nenne es vibe-coding wenn du willst, für mich ist es KI-unterstützte Entwicklung. Ich könnte nie Code von Claudes Qualität produzieren, aber ich kann bessere Architektur und kreative Lösungen schaffen.

---

## Warum es das gibt

Ich bin Seriengründer und helfe Menschen dabei, Unternehmen zu führen. Redaktionsbüros, Content-Produktion, Kundenarbeit. Wir brauchten einen KI-Assistenten, der E-Mail, Kalender, Recherche und Content-Workflows im kleinen Team handhaben könnte.

Alles, was wir ausprobiert haben, hatte das gleiche Problem: Unsere Daten verlassen unsere Infrastruktur und landen auf fremden Servern, unter fremder Jurisdiktion, unter fremden Nutzungsbedingungen. Selbst wenn dir GDPR egal ist, läufst du Gefahr, deine Arbeit, deine Einrichtung und deinen Geschäftskontext zu verlieren, wenn sich das politische oder kommerzielle Rahmenwerk verschiebt. Und genau das passiert gerade.

Anmeldedaten werden weiß Gott wo gespeichert. Es gibt keine Möglichkeit zu prüfen, was die KI zugegriffen und getan hat. Kein Kill-Switch, der in unter einer Minute funktioniert. Revokation kann zum Albtraum werden.

Wir suchten nach etwas, das auf unserer eigenen Infrastruktur läuft, möglicherweise auf einem Rechner im Keller einer netzunabhängigen Farm. Es sollte sich mit den Tools integrieren, die wir bereits nutzen, und uns echte Kontrolle geben. Und irgendwie gab es das nicht.

Also habe ich es gebaut.

Moltagent ist ein KI-Mitarbeiter, der in Nextcloud lebt. Er hat sein eigenes Konto, seine eigenen Dateien, seinen eigenen Kalender, sein eigenes Task-Board und E-Mail. Du teilst mit ihm, was du teilen möchtest, genau wie bei der Einarbeitung eines menschlichen Kollegen. Und du kannst jeden Zugriff mit einem Klick widerrufen, genau wie bei der Verabschiedung eines Angestellten.

Ich teile es als Open Source, weil jedes Unternehmen KI sicher nutzen können sollte und souveräne Business-Infrastruktur nicht proprietär sein sollte.

Nimm es, erkunde es, baue darauf auf. Verbessere es.

Los geht's!

---

## Was es macht

Moltagent ist ein digitales Mitglied für dein Team, kein persönlicher Assistent pro Nutzer. Es baut institutionelles Wissen über alle Interaktionen auf.

**Funktioniert in Nextcloud**:
Dateien, Kalender, Kontakte, E-Mail, Aufgaben, Wiki, Kanban-Boards. Keine externen SaaS-Abhängigkeiten für deine Daten.

**Workflow-Engine**:
Schreibe Regeln als einfache Sätze auf Kanban-Karten. Der Agent liest sie und führt sie aus. Keine visuelle Programmierung, keine Node-Graphen, kein Code. Menschliche Kontrollpunkte (GATE-Label) überall wo du editorisches Urteilsvermögen brauchst.

**Lebendes Gedächtnis**:
Wissens-Wiki mit Vertrauens-Tracking und Frische-Management. Der Agent lernt aus Dokumenten, Konversationen und Workflows. Wissen, das nicht abgerufen wird, verfällt natürlicherweise. Wissen, das benutzt wird, wird stärker.

**Vertrauensgrenzen**:
Jede Operation ist als vertraut oder nicht vertraut klassifiziert. Vertrauliche Arbeit läuft automatisch zu lokalem LLM. Anmeldedaten werden im Moment der Verwendung abgerufen, sofort verworfen. Nie auf der Festplatte gespeichert.

**Souveräne Suche**:
SearXNG + Stract + Mojeek. Kein Google, kein Tracking, keine Filter-Blasen.

**Stimme und E-Mail**:
Speech-to-Text, volle IMAP/SMTP-Integration. Mensch-im-Loop zum Senden.

**Kostencontrolling**:
Per-Modell-Budget-Erzwingung. Tägliche Limits, automatisches Fallback zu lokal wenn Budget aufgebraucht. Du weißt immer, was du ausgibst.

**Mehrsprachig**:
Deutsch, Englisch, Portugiesisch von Tag eins. Das LLM ist die Sprachschicht, nicht der Code.

**Sofortige Sperrung**:
Deaktiviere das Nextcloud-Konto des Agenten. Alle Zugriffe stoppen. Unter 60 Sekunden zur vollständigen Sperrung. Oder widerrufe einzelne API-Anmeldedaten bei Bedarf. Einfach.

---

## Wie es funktioniert

```
┌───────────────────────────────────────────────────────────┐
│                    YOUR INFRASTRUCTURE                    │
│                                                           │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │  Nextcloud    │  │  Moltagent    │  │  Ollama       │  │
│  │  StorageShare │  │  Bot VM       │  │  (Local LLM)  │  │
│  │               │  │               │  │               │  │
│  │  • Identity   │  │               │  │               │  │
│  │  • Files      │  │  • Agent      │  │  • Air-       │  │
│  │  • Passwords  │  │    runtime    │  │    gapped     │  │
│  │  • Calendar   │  │  • No secrets │  │  • Handles    │  │
│  │  • Wiki       │  │    stored     │  │    sensitive  │  │
│  │  • Audit logs │  │               │  │    ops        │  │
│  └───────┬───────┘  └───────┬───────┘  └────────┬──────┘  │
│          │    HTTPS         │   Ollama API      │         │
│          │◄─────────────────┤◄──────────────────┤         │
│          │                  │                   │         │
│          │                  ├──► Cloud LLM APIs │         │
│          │                  │   (allowlisted)   │         │
└──────────┴──────────────────┴───────────────────┴─────────┘
```

Drei Komponenten, Netzwerk-isoliert. Kompromiss einer bedeutet nicht Kompromiss aller. Der Ollama-VM hat keinen Internet-Zugang und Anmeldedaten-sensible Operationen verlassen deine Infrastruktur nie.

→ [Vollständige Architektur-Dokumentation](../docs/architecture.md)

---

## LLM-Provider

Moltagent ist Provider-agnostisch mit 13 unterstützten Adaptern. Wähle deinen Tradeoff:

| Preset          | Cockpit-Name | Was passiert                                            | Kosten     |
| --------------- | ------------ | ------------------------------------------------------- | ---------- |
| **all-local**   | Nur lokal    | Alles läuft auf deinem Ollama. Null Cloud-Kosten.      | €0         |
| **smart-mix**   | Ausgewogen   | Cloud primär, lokal fallback. Pro Job-Typ optimiert.    | ~€3-20/mo  |
| **cloud-first** | Premium      | Nur Cloud. Maximale Qualität.                           | ~€10-50/mo |

Unterstützt: Anthropic, OpenAI, Google, DeepSeek, Mistral, Groq, Perplexity, OpenRouter, xAI, Together, Fireworks, Ollama, oder füge deine eigene hinzu.

Zwei harte Regeln unabhängig vom Preset: Anmeldedaten-Operationen bleiben immer lokal, und alle Presets fallen zu lokal zurück wenn Cloud nicht verfügbar ist. Dein Agent geht nie offline.

→ [Vollständige Provider-Konfiguration und Job-Routing](../docs/providers.md)

---

## Aktueller Stand

**Live-Entwicklungs-Dashboard unter** [public.moltagent.cloud](https://public.moltagent.cloud) - Einsatzkontrolle mit Funktions-Verifizierungsstatus, Architektur-Graph, Commit-Verlauf und Wissens-Lebens-Zyklus-Visualisierung. Live aktualisiert vom Production-VM.

Wir nutzen Moltagent täglich für unsere eigenen Operationen. Hier ein Überblick des Standes:

**Funktioniert und wird täglich genutzt:**

- Nextcloud-Integration (Dateien, Kalender, Kontakte, E-Mail, Wiki, Kanban-Deck)
- Workflow-Engine mit GATE/PAUSED/SCHEDULED/ERROR Label-Zustandsmaschine
- Content-Pipeline (Ideen-Evaluation → Drafting → Revision → Editorial Review → Publishing)
- Wissens-Wiki mit Dokument-Ingest und Entity-Extraktion
- Souveräne Suche (SearXNG + Stract + Mojeek)
- Voice-Pipeline (Speaches STT)
- Kostenerfassung und Budget-Durchsetzung
- LLM-Routing mit 13 Provider-Adaptern
- 217 Tests, alle bestanden

**Funktioniert aber wird noch verfeinert:**

- Workflow-Scheduling und zeitgesteuerte Card-Aktivierung
- Multi-Board-Spawning und Cross-Board-Workflows
- Editorial-Feedback-Schleifen (Revisions-Zyklen)
- Calendar Smart Meetings und RSVP-Tracking

**Noch nicht gebaut:**

- One-Click-Installer
- Web-basierter Setup-Wizard
- Chat-Plattform-Adapter (Slack, Telegram, WhatsApp)
- Drupal / WordPress CMS-Integration
- Föderation zwischen Moltagent-Instanzen

**Bekannte Limitierungen:**

- Schnelles Entwicklungstempo: Architektur kann sich zwischen Releases ändern
- Gebaut für Linux + Nextcloud. Kein Windows, kein macOS, kein Docker (noch nicht)
- Erfordert Vertrautheit mit systemd, SSH und grundlegender Server-Administration
- Der Agent ist nur so gut wie das LLM, das ihn antreibt. Lokale Modelle handhaben einfache Workflows, aber komplexe redaktionelle Arbeit braucht Cloud-Modelle (das könnte sich aber bald ändern, angesichts der rasanten Entwicklung lokaler KI)

---

## Erste Schritte

Moltagent läuft als systemd-Service auf Linux mit Nextcloud-Backend. Das empfohlene Setup nutzt drei Hetzner-VMs mit Netzwerk-Isolation. Monatliche Infrastruktur-Kosten: ~30 Euro/Monat für den Anfang, unter 250 Euro/Monat für ernsthaftes Business.

Das ist keine One-Click-Installation. Du musst mit Server-Administration vertraut sein oder jemand, der das ist.

→ [Setup-Anleitung](../docs/quickstart.md) - Nextcloud-Konfiguration, VM-Deployment, Firewall-Regeln, Credential-Store

→ [Erste Schritte](../docs/getting-started.md) - wenn es läuft, was du tatsächlich in deiner ersten Stunde tust

---

## Wie das gebaut wird

Moltagent wird von einem Solo-Gründer mit Claude als Architektur- und Implementierungs-Partner entwickelt. Die Methodik:

1. **Briefings, nicht Prompts** 
   Jede Funktion beginnt als geschriebenes Architektur-Dokument, das das Problem, das Design, die Edge-Cases und die Exit-Kriterien beschreibt. Diese Briefings sind durchschnittlich 15-25KB groß. Es gibt über 70 davon.

2. **Systemisches Denken vor Code** 
   Wenn ein Bug auftaucht, patchen wir nicht die Instanz. Wir fragen: Was ist die Problemklasse? Was erzeugt sie? Kann man den Generator reparieren? Zwei Instanzen desselben Musters bedeutet: Hör auf zu patchen und find die strukturelle Ursache.

3. **Das TAO guter Ingenieurskunst**
   Kein Regex für Intelligenz. Wenn Code schwache KI kompensiert, verstärke die KI, statt mehr Code hinzuzufügen. Weniger Code, nicht mehr. Die richtige Lösung in der richtigen Höhe ersetzt fünf Lösungen in der falschen. Mehrsprachig von Anfang an. Wenn es nur auf Englisch funktioniert, ist es ein Prototyp, kein Feature.

4. **GEBAUT ≠ VERIFIZIERT**
   Eine Funktion ist nur vollständig nach bestätigtem Produktions-Verhalten, nicht nachdem Tests bestanden haben. Wir laufen jede Änderung in Produktion auf unserer eigenen Infrastruktur, bevor wir sie für fertig erklären.

Die Commit-Historie spiegelt echte Debugging-Sessions, Architektur-Entscheidungen und Produktions-Beobachtungen. Das ist Absicht. Ich möchte, dass der Entwicklungsprozess lesbar ist, nicht nur der finale Code.

---

## Philosophie

### Das Angestellten-Modell

Als ich im Januar 2026 von Agentischer KI erfuhr, war ich sofort Feuer und Flamme. Könnte es Workflows automatisieren, Finance-Admin handhaben, als interaktives Wissens-Repository für meine Kunden fungieren?

Als ich tiefer grub, bekam ich Angst. Echte Angst. Anmeldedaten in Textdateien. Kein Revokations-Pfad. Keine Audit-Spur. Was ist mit Prompt-Injections?

Ich verband die Punkte: Was wenn der KI-Agent in meinem Nextcloud lebt und alles bekommt, das meine Angestellten bekommen? Eine echte Identität, einen echten Workspace, echte Revokation.

Das ist was Moltagent ist.

### Souveräne KI

Souveräne KI sollte kein Buzzword sein. Es bedeutet, dass dein Business nicht davon abhängt, dass jemand anderes weiter funktioniert. Es läuft auf deiner Infrastruktur mit deinen Daten. Und wenn morgen ein Provider verschwindet, kannst du noch arbeiten.

Moltagent läuft auf einem Rechner in deinem Büro, deiner Werkstatt oder deiner Farm. Oder auf einem virtuellen Server bei Hetzner. Du entscheidest.

---

## Dokumentation

|                                            |                                                          |
| ------------------------------------------ | -------------------------------------------------------- |
| [Start](../docs/quickstart.md)              | Starte in 30 Minuten                                     |
| [Erste Schritte](../docs/getting-started.md) | Deine erste Stunde: erstes Gespräch, Daten teilen, echte Aufgaben |
| [Deployment-Anleitung](../docs/deployment.md)   | SearXNG, Speaches, E-Mail, Anmeldedaten, vollständiges Setup    |
| [Architektur](../docs/architecture.md)     | Drei-VM-Isolation, Netzwerk-Segmentierung             |
| [Sicherheits-Modell](../docs/security-model.md) | Vertrauensgrenzen, Credential-Brokering, Threat-Modell |
| [Anmeldedaten](../docs/credentials.md)       | NC Passwords-Feld-Mapping für jede Anmeldeinformation      |
| [Konfiguration](../docs/configuration.md)   | Vollständige Referenz für config.yaml                       |
| [LLM-Provider](../docs/providers.md)       | 13 Adapter, Job-Routing, Kostenoptimierung          |

---

## Beitragen

Dieses Projekt wird kollaborativ mit KI entwickelt. Wenn dir das nicht passt, okay. Der Code ist AGPL-3.0 lizenziert und spricht für sich selbst. 

Siehe [CONTRIBUTING.md](../.github/CONTRIBUTING.md) für Richtlinien.

**Sicherheitsprobleme:** Bitte melde sie unter [security@moltagent.cloud](mailto:security@moltagent.cloud). Öffne keine öffentlichen Issues für Sicherheitslücken.

---

## Lizenz

[AGPL-3.0](../LICENSE)

Wenn du Moltagent verbesserst, profitieren alle davon. 

---

## Danksagungen

- [Nextcloud](https://nextcloud.com) - das Ökosystem, das souveräne KI möglich macht
- [Ollama](https://ollama.com) - lokale LLM-Inferenz
- [Claude](https://anthropic.com) - Architektur-Partner und Implementierungs-Mitarbeiter
- Die Self-Hosted-Community, für die Wertschätzung von Souveränität über Bequemlichkeit

---

```
Deine KI. Deine Infrastruktur. Deine Regeln.
```
