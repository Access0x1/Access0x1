/**
 * Access0x1ProvenanceRegistry — VENDORED forge artifact (abi + creation bytecode).
 *
 * GENERATED, do not hand-edit. Re-vendor from the compiled artifact with:
 *   node lib/artifacts/vendor-provenance-registry.mjs
 * (which reads ../../out/Access0x1ProvenanceRegistry.sol/Access0x1ProvenanceRegistry.json,
 * the forge out/ build output — gitignored at the repo root, so the abi + bytecode
 * are vendored HERE to ship in the web bundle).
 *
 * The creation bytecode is PUBLIC (it is on-chain the moment anyone deploys the
 * contract) — it is safe to commit and ship in the browser bundle; it carries no
 * secret. The admin "Deploy" button feeds these two exports straight into viem's
 * walletClient.deployContract({ abi, bytecode }) so the owner deploys the registry
 * from their OWN browser wallet — no keystore, no server, no private key in the app.
 */
import type { Abi, Hex } from 'viem'

/** The contract ABI, as emitted by forge build. */
export const PROVENANCE_REGISTRY_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ANCHOR_RELEASE_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ANCHOR_SNAPSHOT_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptRepoOwner",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "anchorRelease",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "cid",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "anchorReleaseDigest",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "cid",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "anchorReleaseWithSig",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "cid",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "anchorSnapshot",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "commit",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "anchorSnapshotDigest",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "commit",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "anchorSnapshotWithSig",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "commit",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimRepo",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "domainSeparator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRelease",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "entry",
        "type": "tuple",
        "internalType": "struct IAccess0x1ProvenanceRegistry.Anchor",
        "components": [
          {
            "name": "merkleRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "anchoredAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "cid",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tag",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "commit",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getSnapshot",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "entry",
        "type": "tuple",
        "internalType": "struct IAccess0x1ProvenanceRegistry.Anchor",
        "components": [
          {
            "name": "merkleRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "anchoredAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "cid",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tag",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "commit",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "latestRelease",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "anchoredAt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nonceOf",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingRepoOwnerOf",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "proposed",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proposeRepoOwner",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "releaseCount",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "count",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "repoOwnerOf",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "snapshotCount",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "count",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReleaseAnchored",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "cid",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tag",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RepoClaimed",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RepoOwnerProposed",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "proposedOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RepoOwnerTransferred",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SnapshotAnchored",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "commit",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__BadNonce",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expected",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "supplied",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__BadSignature",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "recovered",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__IndexOutOfBounds",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__NoRelease",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__NotProposedOwner",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "proposed",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__NotRepoOwner",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__RepoAlreadyClaimed",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__RepoNotClaimed",
    "inputs": [
      {
        "name": "repoId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__SignatureExpired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "nowTs",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Access0x1ProvenanceRegistry__ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureLength",
    "inputs": [
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureS",
    "inputs": [
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  }
] as const satisfies Abi

/** The creation (constructor) bytecode — public, safe to ship in the bundle. */
export const PROVENANCE_REGISTRY_BYTECODE: Hex = '0x610160806040523461014b57611bea803803809161001d828561014f565b833981019060408183031261014b5780516001600160401b03811161014b5782610048918301610186565b60208201519092906001600160401b03811161014b576100689201610186565b90610072816101db565b6101205261007f82610371565b6101405260208151910120908160e0526020815191012080610100524660a0526040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a081526100f060c08261014f565b5190206080523060c05260405161174090816104aa823960805181611493015260a05181611550015260c0518161145d015260e051816114e20152610100518161150801526101205181610519015261014051816105420152f35b5f80fd5b601f909101601f19168101906001600160401b0382119082101761017257604052565b634e487b7160e01b5f52604160045260245ffd5b81601f8201121561014b578051906001600160401b03821161017257604051926101ba601f8401601f19166020018561014f565b8284526020838301011161014b57815f9260208093018386015e8301015290565b908151602081105f14610255575090601f815111610215576020815191015160208210610206571790565b5f198260200360031b1b161790565b604460209160405192839163305a27a960e01b83528160048401528051918291826024860152018484015e5f828201840152601f01601f19168101030190fd5b6001600160401b038111610172575f54600181811c91168015610367575b602082101461035357601f8111610321575b50602092601f82116001146102c257928192935f926102b7575b50508160011b915f199060031b1c1916175f5560ff90565b015190505f8061029f565b601f198216935f8052805f20915f5b86811061030957508360019596106102f1575b505050811b015f5560ff90565b01515f1960f88460031b161c191690555f80806102e4565b919260206001819286850151815501940192016102d1565b5f8052601f60205f20910160051c810190601f830160051c015b8181106103485750610285565b5f815560010161033b565b634e487b7160e01b5f52602260045260245ffd5b90607f1690610273565b908151602081105f1461039c575090601f815111610215576020815191015160208210610206571790565b6001600160401b03811161017257600154600181811c9116801561049f575b602082101461035357601f811161046c575b50602092601f821160011461040b57928192935f92610400575b50508160011b915f199060031b1c19161760015560ff90565b015190505f806103e7565b601f1982169360015f52805f20915f5b868110610454575083600195961061043c575b505050811b0160015560ff90565b01515f1960f88460031b161c191690555f808061042e565b9192602060018192868501518155019401920161041b565b60015f52601f60205f20910160051c810190601f830160051c015b81811061049457506103cd565b5f8155600101610487565b90607f16906103bb56fe60806040526004361015610011575f80fd5b5f3560e01c806303bb21b31461098157806325cf1e8d1461090d5780632e583d81146108ce57806331249f2a146108365780633df3ce14146107c75780634b7ca0621461071557806352243b2d146106eb57806352c6a722146106c15780635386b336146106875780637934a683146105f957806384b0196e146105015780639552b529146104cf578063aebb25761461041d578063af89e39f146103eb578063b5212eed146103b1578063b8ebd7b1146102fc578063d25709c514610290578063df86071e14610247578063ed2a2d641461020b578063f3ba4b16146101265763f698da2514610100575f80fd5b34610122575f36600319011261012257602061011a61145a565b604051908152f35b5f80fd5b3461012257602036600319011261012257600435805f52600560205260405f2080549182156101f957505f1982019182116101e5576101c89161016891610b5f565b5080546001600160401b036001830154166101d660036101b46040519561019d876101968160028501610bc4565b0388610b14565b6101ad6040518094819301610bc4565b0382610b14565b604051958695608087526080870190610a53565b908582036020870152610a53565b91604084015260608301520390f35b634e487b7160e01b5f52601160045260245ffd5b6305416b7360e51b5f5260045260245ffd5b34610122576020366003190112610122576004356001600160a01b03811690819003610122575f526006602052602060405f2054604051908152f35b346101225760a0366003190112610122576044356001600160401b0381116101225761011a61027c6020923690600401610a10565b906084359160643591602435600435610d93565b346101225760c0366003190112610122576024356001600160401b038111610122576102c0903690600401610a10565b90604435906001600160401b038211610122576020926102e761011a933690600401610a10565b60a43593608435936064359391600435610d04565b34610122576020366003190112610122576004355f818152600360205260409020546001600160a01b03169033829003610398575f81815260026020908152604080832080546001600160a01b038781166001600160a01b0319808416919091179093556003909452918420805490911690551691907f84fac28f03e056772f96a7bb21b8aab3c8e33ba1f8a9509a04c7401a62272a049080a4005b63f5f2f54160e01b5f526004523360245260445260645ffd5b34610122575f3660031901126101225760206040517f0c98df26819d6a047e6d53fe91f63121b512c917130cdc52fc511bbc02db00028152f35b34610122576020366003190112610122576004355f526002602052602060018060a01b0360405f205416604051908152f35b34610122576040366003190112610122576024356001600160a01b03811690600435908290036101225781156104c0576001600160a01b0361045e82610e01565b16908133036104aa575f81815260036020526040812080546001600160a01b031916851790557ffaf022df5a1360b149a793a13bea6c7d66c34c6ea1ce1e6b2ae7505809359a0b9080a4005b639c25144160e01b5f526004523360245260445ffd5b6373c1386360e11b5f5260045ffd5b34610122576020366003190112610122576004355f526003602052602060018060a01b0360405f205416604051908152f35b34610122575f3660031901126101225761059d61053d7f0000000000000000000000000000000000000000000000000000000000000000611576565b6105667f00000000000000000000000000000000000000000000000000000000000000006115ce565b60206105ab604051926105798385610b14565b5f84525f368137604051958695600f60f81b875260e08588015260e0870190610a53565b908582036040870152610a53565b4660608501523060808501525f60a085015283810360c08501528180845192838152019301915f5b8281106105e257505050500390f35b8351855286955093810193928101926001016105d3565b346101225760c0366003190112610122576004356024356044356001600160401b0381116101225761062f903690600401610a10565b90606435926084359460a4356001600160401b0381116101225760209661011a96610661610682933690600401610a10565b92909161066d86610e01565b61067b83838c8c8c8c610d93565b908761136e565b6111eb565b34610122575f3660031901126101225760206040517fdfe4c767aaad5b1e51af3327c50419214f3ed17569398579400fa0025699c68b8152f35b34610122576020366003190112610122576004355f526004602052602060405f2054604051908152f35b34610122576020366003190112610122576004355f526005602052602060405f2054604051908152f35b346101225760e0366003190112610122576004356024356001600160401b03811161012257610748903690600401610a10565b6044929192356001600160401b0381116101225761076a903690600401610a10565b90606435926084359560a4359560c435966001600160401b038811610122578383828b8561067b6107c29660209f61011a9f8f908f908f906107b0903690600401610a10565b9b909a6107bc89610e01565b98610d04565b6112a6565b34610122576107d536610a3d565b6107dd610b35565b50815f52600460205260405f20918254908183101561081c5761081861080c6108068587610b5f565b50610c45565b60405191829182610a77565b0390f35b8290631bbb10b960e11b5f5260045260245260445260645ffd5b34610122576080366003190112610122576004356024356001600160401b03811161012257610869903690600401610a10565b906044356001600160401b03811161012257610889903690600401610a10565b9290916001600160a01b0361089d86610e01565b1633036108b7579161011a939160209593606435946112a6565b84639c25144160e01b5f526004523360245260445ffd5b34610122576108dc36610a3d565b6108e4610b35565b50815f52600560205260405f20918254908183101561081c5761081861080c6108068587610b5f565b34610122576060366003190112610122576004356044356001600160401b03811161012257610940903690600401610a10565b906001600160a01b0361095284610e01565b16330361096a579061011a91602093602435906111eb565b82639c25144160e01b5f526004523360245260445ffd5b34610122576020366003190112610122576004355f818152600260205260409020546001600160a01b0316806109fa57505f81815260026020526040812080546001600160a01b0319163390811790915591907ffdae58965aaac782bc21e88ad22b109c110905e4ef593e1bb4f99d1a85d4acba9080a3005b906333414c6360e11b5f5260045260245260445ffd5b9181601f84011215610122578235916001600160401b038311610122576020838186019501011161012257565b6040906003190112610122576004359060243590565b805180835260209291819084018484015e5f828201840152601f01601f1916010190565b90610ae29160208152815160208201526001600160401b0360208301511660408201526080610acd610ab8604085015160a0606086015260c0850190610a53565b6060850151848203601f190184860152610a53565b9201519060a0601f1982850301910152610a53565b90565b60a081019081106001600160401b03821117610b0057604052565b634e487b7160e01b5f52604160045260245ffd5b90601f801991011681019081106001600160401b03821117610b0057604052565b60405190610b4282610ae5565b60606080835f81525f602082015282604082015282808201520152565b8054821015610b78575f52600560205f20910201905f90565b634e487b7160e01b5f52603260045260245ffd5b90600182811c92168015610bba575b6020831014610ba657565b634e487b7160e01b5f52602260045260245ffd5b91607f1691610b9b565b5f9291815491610bd383610b8c565b8083529260018116908115610c285750600114610bef57505050565b5f9081526020812093945091925b838310610c0e575060209250010190565b600181602092949394548385870101520191019190610bfd565b915050602093945060ff929192191683830152151560051b010190565b9060046080604051610c5681610ae5565b610cbb8195805483526001600160401b036001820154166020840152604051610c86816101ad8160028601610bc4565b6040840152604051610c9f816101ad8160038601610bc4565b6060840152610cb46040518096819301610bc4565b0384610b14565b0152565b9291926001600160401b038211610b005760405191610ce8601f8201601f191660200184610b14565b829481845281830111610122578281602093845f960137010152565b9592610d1b610d2a92610ae2999697943691610cbf565b60208151910120953691610cbf565b602081519101206040519460208601967f0c98df26819d6a047e6d53fe91f63121b512c917130cdc52fc511bbc02db0002885260408701526060860152608085015260a084015260c083015260e082015260e08152610d8b61010082610b14565b519020611434565b939092610ae29592610da6913691610cbf565b602081519101206040519360208501957fdfe4c767aaad5b1e51af3327c50419214f3ed17569398579400fa0025699c68b875260408601526060850152608084015260a083015260c082015260c08152610d8b60e082610b14565b5f818152600260205260409020546001600160a01b031691908215610e235750565b63480ede2b60e01b5f5260045260245ffd5b919091805468010000000000000000811015610b0057610e5a91600182018155610b5f565b6111b85782518155600181016001600160401b036020850151166001600160401b03198254161790556002810160408401518051906001600160401b038211610b00578190610ea98454610b8c565b601f8111611168575b50602090601f8311600114611105575f926110fa575b50508160011b915f199060031b1c19161790555b6003810160608401518051906001600160401b038211610b0057610f008354610b8c565b601f81116110b5575b50602090601f831160011461104c57918060049492608096945f92611041575b50508160011b915f199060031b1c19161790555b019201519182516001600160401b038111610b0057610f5c8254610b8c565b601f8111610ffc575b506020601f8211600114610f9e57819293945f92610f93575b50508160011b915f199060031b1c1916179055565b015190505f80610f7e565b601f19821690835f52805f20915f5b818110610fe457509583600195969710610fcc575b505050811b019055565b01515f1960f88460031b161c191690555f8080610fc2565b9192602060018192868b015181550194019201610fad565b825f5260205f20601f830160051c81019160208410611037575b601f0160051c01905b81811061102c5750610f65565b5f815560010161101f565b9091508190611016565b015190505f80610f29565b90601f19831691845f52815f20925f5b81811061109d5750926001928592608098966004989610611085575b505050811b019055610f3d565b01515f1960f88460031b161c191690555f8080611078565b9293602060018192878601518155019501930161105c565b835f5260205f20601f840160051c810191602085106110f0575b601f0160051c01905b8181106110e55750610f09565b5f81556001016110d8565b90915081906110cf565b015190505f80610ec8565b5f8581528281209350601f198516905b8181106111505750908460019594939210611138575b505050811b019055610edc565b01515f1960f88460031b161c191690555f808061112b565b92936020600181928786015181550195019301611115565b909150835f5260205f20601f840160051c810191602085106111ae575b90601f859493920160051c01905b8181106111a05750610eb2565b5f8155849350600101611193565b9091508190611185565b634e487b7160e01b5f525f60045260245ffd5b908060209392818452848401375f828201840152601f01601f1916010190565b9061128894937f51d3a2b59b13b74e9793726bd9673cc087caf5b8b2b2a523da9de46cb3a580bd91835f5260046020526112a160405f209586549889976040519061123582610ae5565b8582526001600160401b0342166020830152604051611255602082610b14565b5f8152604083015260405161126b602082610b14565b5f8152606083015261127e368886610cbf565b6080830152610e35565b60405193849384526040602085015260408401916111cb565b0390a3565b929161133e96956113637fa53f63ce0b8ffe73ed4ecf211172e9be9f5c28563c440c21d477de32d1ef38e494865f52600560205260405f209788549a8b99604051906112f182610ae5565b8682526001600160401b034216602083015261130e36898b610cbf565b604083015261131e368587610cbf565b6060830152604051611331602082610b14565b5f81526080830152610e35565b6113556040519687966060885260608801916111cb565b9185830360208701526111cb565b9060408301520390a3565b939695969491929480421161141e57506001600160a01b03165f81815260066020526040902054909690948581036114045750916113b46113ba926113c3943691610cbf565b90611605565b9092919261163f565b6001600160a01b0316908482036113e9575050600191925f5260066020520160405f2055565b84925063255b1eab60e11b5f5260045260245260445260645ffd5b85886312861e9f60e31b5f5260045260245260445260645ffd5b6334e08a8d60e21b5f526004524260245260445ffd5b60429061143f61145a565b906040519161190160f01b8352600283015260228201522090565b307f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316148061154d575b156114b5577f000000000000000000000000000000000000000000000000000000000000000090565b60405160208101907f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f82527f000000000000000000000000000000000000000000000000000000000000000060408201527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260a0815261154760c082610b14565b51902090565b507f0000000000000000000000000000000000000000000000000000000000000000461461148c565b60ff81146115bc5760ff811690601f82116115ad576040519161159a604084610b14565b6020808452838101919036833783525290565b632cd44ac360e21b5f5260045ffd5b50604051610ae2816101ad815f610bc4565b60ff81146115f25760ff811690601f82116115ad576040519161159a604084610b14565b50604051610ae2816101ad816001610bc4565b81519190604183036116355761162e9250602082015190606060408401519301515f1a906116b3565b9192909190565b50505f9160029190565b600481101561169f5780611651575050565b600181036116685763f645eedf60e01b5f5260045ffd5b60028103611683575063fce698f760e01b5f5260045260245ffd5b60031461168d5750565b6335e2f38360e21b5f5260045260245ffd5b634e487b7160e01b5f52602160045260245ffd5b91907f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08411611735579160209360809260ff5f9560405194855216868401526040830152606082015282805260015afa1561172a575f516001600160a01b0381161561172057905f905f90565b505f906001905f90565b6040513d5f823e3d90fd5b5050505f916003919056'
