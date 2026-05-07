# Sistemi Peer-to-Peer e Blockchain
## Progetto Finale A.A. 2025/26
## Servizio di Prestito Decentralizzato
**Versione 1.0 — 5 maggio 2026**

---

## 1. Descrizione del Servizio

L'obiettivo del progetto è implementare un servizio decentralizzato su Ethereum che consente la raccolta collettiva di fondi messi a disposizione per prestiti ad altri utenti. Il servizio opera tramite un **pool comune** in cui i **contributori** possono depositare o prelevare valore, e i **richiedenti** possono prendere denaro in prestito.

La decisione su quali prestiti finanziare viene presa democraticamente da tutti i contributori, in proporzione al loro contributo disponibile nel pool. Inoltre, il servizio si affida a un oracolo centralizzato e fidato per leggere i saldi degli indirizzi Bitcoin, utilizzati come prova di liquidità al momento della richiesta di un prestito.

I fondi nel pool comune (depositati o prelevati dai rispettivi contributori) possono essere bloccati da prestiti approvati. I richiedenti possono inviare richieste di nuovi prestiti, ma sono i contributori a votare per accettare o rifiutare una proposta. Il voto di ogni contributore è proporzionale alla quantità di fondi da lui depositati nel pool che non sono attualmente bloccati da un prestito precedente.

I richiedenti devono dimostrare la sostenibilità del prestito indicando un indirizzo Bitcoin con fondi sufficienti a coprire l'importo richiesto¹. Una volta approvato il prestito, l'importo corrispondente viene bloccato nel pool e il prestito può essere successivamente rimborsato con interessi in rate separate. Per proteggere i contributori dai prestiti non rimborsati, una parte degli interessi viene raccolta in un **pool di compensazione**, utilizzabile dai contributori dei prestiti falliti per recuperare le perdite.

Il sistema è implementato tramite un insieme di smart contract, accompagnati da un oracolo off-chain che implementa un protocollo cross-chain di base per scrivere informazioni aggregate sulla blockchain Bitcoin (saldi cumulativi disponibili degli indirizzi) su Ethereum.

> ¹ *Semplificazione a scopo didattico, non sicura nella pratica: il richiedente non deve dimostrare la proprietà dei fondi Bitcoin indicati come garanzia, e i fondi non vengono bloccati, quindi potrebbero essere spesi dopo la concessione del prestito.*

---

## 1.1 Attori

Gli utenti possono interagire con il sistema come **contributori** o **richiedenti** (lo stesso utente può ricoprire entrambi i ruoli contemporaneamente).

- È considerato **contributore** qualsiasi utente con un importo non nullo depositato nel pool (incluso il valore attualmente bloccato in prestiti).
- È considerato **richiedente** qualsiasi utente con una proposta di prestito attiva, un prestito attivo, o un prestito concesso/rifiutato.

Un contributore deposita e preleva valore dal pool, matura interessi sui prestiti riusciti, può essere compensato per i prestiti falliti tramite il pool di compensazione, e può votare per accettare o rifiutare nuove proposte di prestito.

Un richiedente può proporre un nuovo prestito (specificando importo, tasso di interesse e durata), eseguire un prestito approvato, e rimborsare un prestito attivo.

---

## 1.2 Gestione dei Pool

Il servizio gestisce almeno due pool: il **pool di finanziamento** e il **pool di compensazione**.

Il **pool di finanziamento** contiene tutto il valore depositato dai contributori. Parte di questo valore può essere bloccata in prestiti attivi. Ogni contributore può depositare nuovo valore o prelevare qualsiasi quantità del proprio deposito non attualmente bloccata in un prestito.

Il **pool di compensazione** contiene parte del valore maturato come interessi dai prestiti passati. Nuovo valore viene aggiunto dopo ogni prestito rimborsato; il valore viene prelevato per coprire i prestiti falliti.

---

## 1.3 Operazioni

### Operazioni dei Contributori

- **Deposito nel pool di finanziamento.** Qualsiasi utente può depositare un importo superiore al deposito minimo (costante fissa).

- **Prelievo dal pool di finanziamento.** L'importo prelevato non può superare il valore depositato dall'utente nel pool che NON è attualmente bloccato in un prestito. Questo valore (variabile per utente e nel tempo) è denominato **valore disponibile**.

- **Voto su una proposta di prestito attiva.** Il voto è un valore booleano approva/rifiuta e può essere espresso solo per una proposta attiva. Non votare equivale a un voto implicito di rifiuto.

- **Richiesta di compensazione per un prestito fallito.** Un prestito è considerato **fallito** se non è stato interamente rimborsato e il tempo attuale supera la data di scadenza. I prestiti parzialmente rimborsati e scaduti sono considerati falliti.
  - La compensazione può essere richiesta solo per un prestito fallito.
  - Il contributore riceve dal pool di compensazione il valore necessario a recuperare la quota bloccata nel prestito non ancora rimborsata dall'applicante inadempiente (gli interessi pagati da rimborsi parziali non vengono considerati).
  - Il contributore può ricevere meno del dovuto se il pool di compensazione non è sufficientemente capiente.
  - Questa operazione può essere eseguita più volte dallo stesso contributore per lo stesso prestito fallito, man mano che il pool si riempie.
  - Richiedere una compensazione riduce proporzionalmente i rimborsi futuri dell'applicante, nel caso in cui questi rimborsi arrivino in seguito.
  - Una compensazione marca il prestito come fallito, influenzando la percentuale globale di garanzia.
  - Un prestito può essere marcato come fallito una sola volta e non può tornare a essere considerato riuscito, anche se venisse interamente rimborsato in seguito.

---

### Operazioni dei Richiedenti

- **Richiesta di registrazione del saldo di un indirizzo Bitcoin** tramite l'oracolo di liquidità Bitcoin (vedi sezione 1.4).

- **Invio di una nuova proposta di prestito.** Il richiedente specifica: importo, tasso di interesse (percentuale dell'importo che verrà accreditata ai contributori che hanno sostenuto il prestito, valore naturale tra 1 e 100 inclusi), durata, e un indirizzo Bitcoin come prova di liquidità.

- **Richiesta di risoluzione di una proposta di prestito.** La risoluzione può essere richiesta solo per proposte in fase di votazione da più tempo del periodo minimo di votazione. Può essere richiesta solo dall'applicante originale.
  - Se il valore disponibile cumulativo nel pool è inferiore all'importo richiesto, la proposta viene rifiutata.
  - Se il controllo di liquidità Bitcoin fallisce, la proposta viene rifiutata.
  - La risoluzione valuta l'esito contando i voti di approvazione ponderati ricevuti. I voti sono ponderati sul valore disponibile di ogni contributore rispetto al totale disponibile nel pool. I contributori che non hanno votato sono considerati come voti di rifiuto.
  - Se la maggioranza ponderata è per il rifiuto (o in caso di pareggio), la proposta viene chiusa.
  - Se il risultato è approvazione, la proposta viene chiusa e viene creato un nuovo **contratto di gestione del prestito** che gestisce il valore bloccato come **prestito attivo**.
  - Il valore del prestito viene bloccato da tutti i contributori proporzionalmente al loro valore disponibile. Ad esempio, se i valori disponibili sono 10 (contributore 1), 20 (contributore 2), 30 (contributore 3) e l'importo richiesto è 12: vengono bloccati 2 dal contributore 1, 4 dal contributore 2, 6 dal contributore 3.
  - Qualsiasi discrepanza residua dovuta alla precisione finita dell'aritmetica viene dedotta dall'importo del prestito (l'importo effettivamente erogato DEVE riflettere questa discrepanza).
  - Il nuovo prestito attivo viene impostato con la percentuale di garanzia corrente.

- **Rimborso parziale di un prestito.** Un richiedente può rimborsare parzialmente uno dei propri prestiti attivi o falliti. Solo l'applicante originale può rimborsare il proprio prestito. È possibile rimborsare anche più dell'importo originale (anche se economicamente irrazionale).
  - Il valore accreditato tramite un rimborso viene suddiviso in componente **interessi** e **capitale**.
  - Il capitale viene restituito ai contributori in ordine decrescente di valore bloccato (al momento della creazione del prestito, senza tener conto dei rimborsi parziali già effettuati); in caso di parità, si ordina per indirizzo del contributore.
  - Qualsiasi importo che supera il capitale originale del prestito (dopo che tutti i contributori sono stati rimborsati) viene accreditato al pool di compensazione.
  - Gli interessi vengono suddivisi tra **guadagno** e **garanzia** in base alla percentuale di garanzia del prestito. Il guadagno viene accreditato direttamente ai contributori (non al pool) in proporzione al valore bloccato. La garanzia va al pool di compensazione.
  - Qualsiasi discrepanza residua per precisione aritmetica viene accreditata al pool di compensazione.
  - Se con questa operazione viene rimborsato l'intero importo (o più), il prestito viene marcato come **riuscito**, influenzando la percentuale globale di garanzia, e viene chiuso.

---

### Note e Costanti

**Note:**
- Tutti i periodi di tempo vengono misurati in differenza di block height. Ad esempio, un tempo di 10 significa una differenza di 10 blocchi tra il blocco corrente e il blocco originale.

**Costanti:**
| Costante | Valore |
|---|---|
| Periodo di votazione della proposta | 12 blocchi |
| Importo minimo di deposito | 100.000 wei |
| Percentuale di garanzia iniziale | 50 (range 1–100; +5 per ogni prestito fallito, -5 per ogni prestito riuscito) |
| Indirizzo oracolo liquidità Bitcoin | indirizzo del contratto on-chain dell'oracolo |
| Fee minima oracolo Bitcoin | gas cost dell'operazione di aggiornamento × 0,1 gwei |
| Tasso di cambio BTC/ETH | 1 BTC = 30 ETH |

---

## 1.4 L'Oracolo di Liquidità Bitcoin

È richiesta l'implementazione di un servizio oracolo centralizzato e fidato che legga la blockchain Bitcoin, calcoli il saldo disponibile di un indirizzo Bitcoin e salvi questo valore in uno smart contract su Ethereum.

**Componente on-chain (Ethereum):**
- Smart contract che memorizza il saldo disponibile (in BTC) di un insieme di indirizzi Bitcoin.
- Il contratto espone una funzione per ricevere richieste di aggiornamento del saldo di un indirizzo Bitcoin (o aggiungerne uno nuovo). La funzione richiede il pagamento di una fee (≥ fee minima dell'oracolo) per essere valida.

**Componente off-chain:**
- L'oracolo gestisce tutte le nuove richieste interrogando la blockchain Bitcoin aggiornata, calcolando il saldo disponibile dell'indirizzo target (somma di tutti gli UTXO non spesi) e aggiornando il valore nel contratto.

**Interazione con il servizio di prestito:**
- I richiedenti *possono* (ma non sono obbligati) richiedere all'oracolo di aggiornare il saldo dell'indirizzo Bitcoin che intendono usare come prova di liquidità.
- Durante la risoluzione di una proposta, viene eseguito il **controllo di liquidità Bitcoin**: si legge dal contratto oracolo il saldo dell'indirizzo Bitcoin associato alla proposta, lo si converte in ether usando il tasso di cambio BTC/ETH, e si verifica che il saldo risultante sia maggiore o uguale all'importo richiesto. Se il saldo è sufficiente, il controllo è superato; altrimenti fallisce.
- Non è richiesta alcuna firma o prova di proprietà dell'indirizzo Bitcoin (semplificazione didattica).

**Requisito implementativo:** Il codice off-chain deve essere progettato per elaborare un nuovo blocco Bitcoin alla volta, ma deve essere eseguito **solo sui primi 131.000 blocchi** della blockchain Bitcoin mainnet (come visto negli esempi a lezione), per evitare tempi di sincronizzazione eccessivi.

---

## 1.5 Requisiti di Implementazione

### Smart Contract
- Emettere **eventi** quando necessario (es. quando viene inviata una nuova proposta).
- Ogni nuovo prestito attivo deve essere gestito da uno **smart contract dedicato** appena deployato.
- Gestire correttamente la **terminazione** dei contratti e l'**aggiornabilità** del contratto principale.

### Testing e Deployment
- Usare **Hardhat** per i test. Fornire file di test che dimostrino la corretta esecuzione dei contratti in diverse circostanze e comportamenti degli utenti.
- Usare una **catena privata locale** basata sul file genesis fornito. Gli account pre-finanziati possono essere usati SOLO per trasferire valore ad altri account; non possono essere usati per deployare contratti o eseguire altri tipi di transazioni.
- Fornire uno **script Python** per l'inizializzazione del servizio (inclusa la creazione degli account necessari).
- Fornire uno **script Python** che esegua un insieme esemplificativo di operazioni dimostrando il corretto funzionamento del servizio. Lo script deve stampare i saldi degli account coinvolti dopo ogni modifica significativa, oltre alle variabili di stato rilevanti.
- Fornire uno **script Python** che implementi una strategia automatizzata per un contributore che approva sempre qualsiasi nuova proposta di prestito (anche se il voto è irrilevante perché tutti i fondi sono bloccati). Il contributore deve "accorgersi" quando vengono fatte nuove proposte.
- Fornire test o script per misurare il **gas cost** di ogni operazione (come visto a lezione).
- Mostrare come modificare gli smart contract per introdurre una **vulnerabilità di reentrancy** e fornire un test che esegua un attacco di reentrancy sul codice modificato (con eventuale contratto malevolo ad hoc).
- Discutere se esiste una **strategia malevola** con cui un contributore può ottenere una remunerazione iniqua a spese degli altri contributori onesti (senza sfruttare reentrancy), ad esempio sfruttando la regola di maggioranza nel rimborso dei prestiti.

---

## 2. Regole di Consegna

Il materiale da consegnare per la valutazione comprende:
- Tutto il codice sorgente Solidity degli smart contract.
- Tutti gli script usati per testing e deployment (come specificato nella sezione 1.5).
- Uno zip della cartella Hardhat usata durante i test.
- Un **report PDF di massimo 5 pagine** contenente:
  - Breve descrizione delle scelte principali nell'implementazione degli smart contract.
  - Risultati della valutazione del gas, modifica per reentrancy, discussione delle strategie malevole (come da sezione 1.5).
  - Breve manuale utente con le istruzioni per usare il codice fornito.

Tutto il materiale (organizzato in una struttura di cartelle intelligibile) deve essere consegnato in un **unico file zip su Moodle**. Il progetto sarà discusso durante l'esame orale (che include sia la discussione del progetto sia argomenti delle lezioni) nella prima sessione disponibile a cui lo studente si è iscritto. Lo studente può usare il proprio laptop durante la discussione. Il progetto deve essere sviluppato da un gruppo di **massimo 2 studenti**, ma ogni studente deve essere in grado di discuterlo da solo.
