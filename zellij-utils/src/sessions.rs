use crate::{
    consts::{
        session_info_folder_for_session, session_layout_cache_file_name,
        ZELLIJ_SESSION_INFO_CACHE_DIR, ZELLIJ_SOCK_DIR,
    },
    envs,
    input::layout::Layout,
    ipc::{ClientToServerMsg, ServerToClientMsg},
    ipc::{IpcReceiverWithContext, IpcSenderWithContext, IpcSocketStream},
};
use anyhow;
use humantime::format_duration;
#[cfg(unix)]
use interprocess::local_socket::LocalSocketStream;
use std::collections::HashMap;
use std::iter::empty;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::time::{Duration, SystemTime};
use std::{
    fs::{self, DirEntry},
    io, process,
};
use suggest::Suggest;

pub fn get_sessions() -> Result<Vec<(String, Duration)>, io::ErrorKind> {
    match iter_sessions() {
        Ok(files) => {
            let mut sessions = Vec::new();
            files.for_each(|file| {
                let file_name = file.file_name().into_string().unwrap();
                let ctime = std::fs::metadata(&file.path())
                    .ok()
                    .and_then(|f| f.created().ok())
                    .and_then(|d| d.elapsed().ok())
                    .unwrap_or_default();
                let duration = Duration::from_secs(ctime.as_secs());
                #[cfg(unix)]
                if file.file_type().unwrap().is_socket().unwrap() && assert_socket(&file_name) {
                    sessions.push((file_name, duration));
                }
                #[cfg(windows)]
                if is_socket(&file).unwrap_or(false) {
                    sessions.push((file_name, duration));
                }
            });
            Ok(sessions)
        },
        Err(err) => Err(err.kind()),
    }
}

fn iter_sessions() -> Result<Box<dyn Iterator<Item = DirEntry>>, io::Error> {
    match fs::read_dir(&*ZELLIJ_SOCK_DIR) {
        Ok(files) => Ok(Box::new(files.map(|file| file.unwrap()))),
        Err(err) if io::ErrorKind::NotFound != err.kind() => Err(err),
        Err(_) => Ok(Box::new(empty())),
    }
}

fn is_socket(file: &DirEntry) -> io::Result<bool> {
    crate::is_socket(file)
}

pub fn get_resurrectable_sessions() -> Vec<(String, Duration)> {
    match fs::read_dir(&*ZELLIJ_SESSION_INFO_CACHE_DIR) {
        Ok(files_in_session_info_folder) => {
            let files_that_are_folders = files_in_session_info_folder
                .filter_map(|f| f.ok().map(|f| f.path()))
                .filter(|f| f.is_dir());
            files_that_are_folders
                .filter_map(|folder_name| {
                    let layout_file_name =
                        session_layout_cache_file_name(&folder_name.display().to_string());
                    let ctime = match std::fs::metadata(&layout_file_name)
                        .and_then(|metadata| metadata.created())
                    {
                        Ok(created) => Some(created),
                        Err(_e) => None,
                    };
                    let elapsed_duration = ctime
                        .map(|ctime| {
                            Duration::from_secs(ctime.elapsed().ok().unwrap_or_default().as_secs())
                        })
                        .unwrap_or_default();
                    let session_name = folder_name
                        .file_name()
                        .map(|f| std::path::PathBuf::from(f).display().to_string())?;
                    if std::path::Path::new(&layout_file_name).exists() {
                        Some((session_name, elapsed_duration))
                    } else {
                        None
                    }
                })
                .collect()
        },
        Err(e) => {
            log::error!(
                "Failed to read session_info cache folder: \"{:?}\": {:?}",
                &*ZELLIJ_SESSION_INFO_CACHE_DIR,
                e
            );
            vec![]
        },
    }
}

pub fn get_resurrectable_session_names() -> Vec<String> {
    match fs::read_dir(&*ZELLIJ_SESSION_INFO_CACHE_DIR) {
        Ok(files_in_session_info_folder) => {
            let files_that_are_folders = files_in_session_info_folder
                .filter_map(|f| f.ok().map(|f| f.path()))
                .filter(|f| f.is_dir());
            files_that_are_folders
                .filter_map(|folder_name| {
                    let folder = folder_name.display().to_string();
                    let resurrection_layout_file = session_layout_cache_file_name(&folder);
                    if std::path::Path::new(&resurrection_layout_file).exists() {
                        folder_name
                            .file_name()
                            .map(|f| format!("{}", f.to_string_lossy()))
                    } else {
                        None
                    }
                })
                .collect()
        },
        Err(e) => {
            log::error!(
                "Failed to read session_info cache folder: \"{:?}\": {:?}",
                &*ZELLIJ_SESSION_INFO_CACHE_DIR,
                e
            );
            vec![]
        },
    }
}

pub fn get_sessions_sorted_by_mtime() -> anyhow::Result<Vec<String>> {
    match iter_sessions() {
        Ok(files) => {
            let mut sessions_with_mtime: Vec<(String, SystemTime)> = Vec::new();
            for file in files {
                let file = file;
                let file_name = file.file_name().into_string().unwrap();
                let file_modified_at = file.metadata()?.modified()?;
                if is_socket(&file)? && assert_socket(&file_name) {
                    sessions_with_mtime.push((file_name, file_modified_at));
                }
            }
            sessions_with_mtime.sort_by_key(|x| x.1); // the oldest one will be the first

            let sessions = sessions_with_mtime.iter().map(|x| x.0.clone()).collect();
            Ok(sessions)
        },
        Err(err) if io::ErrorKind::NotFound != err.kind() => Err(err.into()),
        Err(_) => Ok(Vec::with_capacity(0)),
    }
}

fn assert_socket(name: &str) -> bool {
    let path = &*ZELLIJ_SOCK_DIR.join(name);
    match IpcSocketStream::connect(path) {
        Ok(stream) => {
            let mut receiver = IpcReceiverWithContext::new(stream);
            let mut sender = receiver.get_sender();
            let _ = sender.send(ClientToServerMsg::ConnStatus);
            let _ = sender.send(ClientToServerMsg::ConnStatus);
            match receiver.recv() {
                Some((ServerToClientMsg::Connected, _)) => true,
                None | Some((_, _)) => false,
            }
        },
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {
            drop(fs::remove_file(path));
            false
        },
        Err(_) => false,
    }
}

pub fn print_sessions(
    mut sessions: Vec<(String, Duration, bool)>,
    no_formatting: bool,
    short: bool,
    reverse: bool,
) {
    // (session_name, timestamp, is_dead)
    let curr_session = envs::get_session_name().unwrap_or_else(|_| "".into());
    sessions.sort_by(|a, b| {
        if reverse {
            // sort by `Duration` ascending (newest would be first)
            a.1.cmp(&b.1)
        } else {
            b.1.cmp(&a.1)
        }
    });
    sessions
        .iter()
        .for_each(|(session_name, timestamp, is_dead)| {
            if short {
                println!("{}", session_name);
                return;
            }
            if no_formatting {
                let suffix = if curr_session == *session_name {
                    format!("(current)")
                } else if *is_dead {
                    format!("(EXITED - attach to resurrect)")
                } else {
                    String::new()
                };
                let timestamp = format!("[Created {} ago]", format_duration(*timestamp));
                println!("{} {} {}", session_name, timestamp, suffix);
            } else {
                let formatted_session_name = format!("\u{1b}[32;1m{}\u{1b}[m", session_name);
                let suffix = if curr_session == *session_name {
                    format!("(current)")
                } else if *is_dead {
                    format!("(\u{1b}[31;1mEXITED\u{1b}[m - attach to resurrect)")
                } else {
                    String::new()
                };
                let timestamp = format!(
                    "[Created \u{1b}[35;1m{}\u{1b}[m ago]",
                    format_duration(*timestamp)
                );
                println!("{} {} {}", formatted_session_name, timestamp, suffix);
            }
        })
}

pub fn print_sessions_with_index(sessions: Vec<String>) {
    let curr_session = envs::get_session_name().unwrap_or_else(|_| "".into());
    for (i, session) in sessions.iter().enumerate() {
        let suffix = if curr_session == *session {
            " (current)"
        } else {
            ""
        };
        println!("{}: {}{}", i, session, suffix);
    }
}

pub enum ActiveSession {
    None,
    One(String),
    Many,
}

pub fn get_active_session() -> ActiveSession {
    match get_sessions() {
        Ok(sessions) if sessions.is_empty() => ActiveSession::None,
        Ok(mut sessions) if sessions.len() == 1 => ActiveSession::One(sessions.pop().unwrap().0),
        Ok(_) => ActiveSession::Many,
        Err(e) => {
            eprintln!("Error occurred: {:?}", e);
            process::exit(1);
        },
    }
}

pub fn kill_session(name: &str) {
    let path = &*ZELLIJ_SOCK_DIR.join(name);
    match IpcSocketStream::connect(path) {
        Ok(stream) => {
            let _ = IpcSenderWithContext::new(stream).send(ClientToServerMsg::KillSession);
        },
        Err(e) => {
            eprintln!("Error occurred: {:?}", e);
            process::exit(1);
        },
    };
}

pub fn delete_session(name: &str, force: bool) {
    if force {
        let path = &*ZELLIJ_SOCK_DIR.join(name);
        let _ = IpcSocketStream::connect(path).map(|stream| {
            IpcSenderWithContext::new(stream)
                .send(ClientToServerMsg::KillSession)
                .ok();
        });
    }
    if let Err(e) = std::fs::remove_dir_all(session_info_folder_for_session(name)) {
        if e.kind() == std::io::ErrorKind::NotFound {
            eprintln!("Session: {:?} not found.", name);
            process::exit(2);
        } else {
            log::error!("Failed to remove session {:?}: {:?}", name, e);
        }
    } else {
        println!("Session: {:?} successfully deleted.", name);
    }
}

pub fn list_sessions(no_formatting: bool, short: bool, reverse: bool) {
    let exit_code = match get_sessions() {
        Ok(running_sessions) => {
            let resurrectable_sessions = get_resurrectable_sessions();
            let mut all_sessions: HashMap<String, (Duration, bool)> = resurrectable_sessions
                .iter()
                .map(|(name, timestamp)| (name.clone(), (timestamp.clone(), true)))
                .collect();
            for (session_name, duration) in running_sessions {
                all_sessions.insert(session_name.clone(), (duration, false));
            }
            if all_sessions.is_empty() {
                eprintln!("No active zellij sessions found.");
                1
            } else {
                print_sessions(
                    all_sessions
                        .iter()
                        .map(|(name, (timestamp, is_dead))| {
                            (name.clone(), timestamp.clone(), *is_dead)
                        })
                        .collect(),
                    no_formatting,
                    short,
                    reverse,
                );
                0
            }
        },
        Err(e) => {
            eprintln!("Error occurred: {:?}", e);
            1
        },
    };
    process::exit(exit_code);
}

#[derive(Debug, Clone)]
pub enum SessionNameMatch {
    AmbiguousPrefix(Vec<String>),
    UniquePrefix(String),
    Exact(String),
    None,
}

pub fn match_session_name(prefix: &str) -> Result<SessionNameMatch, io::ErrorKind> {
    let sessions = get_sessions()?;

    let filtered_sessions: Vec<_> = sessions
        .iter()
        .filter(|s| s.0.starts_with(prefix))
        .collect();

    if filtered_sessions.iter().any(|s| s.0 == prefix) {
        return Ok(SessionNameMatch::Exact(prefix.to_string()));
    }

    Ok({
        match &filtered_sessions[..] {
            [] => SessionNameMatch::None,
            [s] => SessionNameMatch::UniquePrefix(s.0.to_string()),
            _ => SessionNameMatch::AmbiguousPrefix(
                filtered_sessions.into_iter().map(|s| s.0.clone()).collect(),
            ),
        }
    })
}

pub fn session_exists(name: &str) -> Result<bool, io::ErrorKind> {
    match match_session_name(name) {
        Ok(SessionNameMatch::Exact(_)) => Ok(true),
        Ok(_) => Ok(false),
        Err(e) => Err(e),
    }
}

// if the session is resurrecable, the returned layout is the one to be used to resurrect it
pub fn resurrection_layout(session_name_to_resurrect: &str) -> Result<Option<Layout>, String> {
    let layout_file_name = session_layout_cache_file_name(&session_name_to_resurrect);
    let raw_layout = match std::fs::read_to_string(&layout_file_name) {
        Ok(raw_layout) => raw_layout,
        Err(_e) => {
            return Ok(None);
        },
    };
    match Layout::from_kdl(
        &raw_layout,
        Some(layout_file_name.display().to_string()),
        None,
        None,
    ) {
        Ok(layout) => Ok(Some(layout)),
        Err(e) => {
            log::error!(
                "Failed to parse resurrection layout file {}: {}",
                layout_file_name.display(),
                e
            );
            return Err(format!(
                "Failed to parse resurrection layout file {}: {}.",
                layout_file_name.display(),
                e
            ));
        },
    }
}

pub fn assert_session(name: &str) {
    match session_exists(name) {
        Ok(result) => {
            if result {
                return;
            } else {
                println!("No session named {:?} found.", name);
                if let Some(sugg) = get_sessions()
                    .unwrap()
                    .iter()
                    .map(|s| s.0.clone())
                    .collect::<Vec<_>>()
                    .suggest(name)
                {
                    println!("  help: Did you mean `{}`?", sugg);
                }
            }
        },
        Err(e) => {
            eprintln!("Error occurred: {:?}", e);
        },
    };
    process::exit(1);
}

pub fn assert_dead_session(name: &str, force: bool) {
    match session_exists(name) {
        Ok(exists) => {
            if exists && !force {
                println!(
                    "A session by the name {:?} exists and is active, use --force to delete it.",
                    name
                )
            } else if exists && force {
                println!("A session by the name {:?} exists and is active, but will be force killed and deleted.", name);
                return;
            } else {
                return;
            }
        },
        Err(e) => {
            eprintln!("Error occurred: {:?}", e);
        },
    };
    process::exit(1);
}

pub fn assert_session_ne(name: &str) {
    if name.trim().is_empty() {
        eprintln!("Session name cannot be empty. Please provide a specific session name.");
        process::exit(1);
    }
    if name == "." || name == ".." {
        eprintln!("Invalid session name: \"{}\".", name);
        process::exit(1);
    }
    if name.contains('/') {
        eprintln!("Session name cannot contain '/'.");
        process::exit(1);
    }

    match session_exists(name) {
        Ok(result) if !result => {
            let resurrectable_sessions = get_resurrectable_session_names();
            if resurrectable_sessions.iter().find(|s| s == &name).is_some() {
                println!("Session with name {:?} already exists, but is dead. Use the attach command to resurrect it or, the delete-session command to kill it or specify a different name.", name);
            } else {
                return
            }
        }
        Ok(_) => println!("Session with name {:?} already exists. Use attach command to connect to it or specify a different name.", name),
        Err(e) => eprintln!("Error occurred: {:?}", e),
    };
    process::exit(1);
}

pub fn generate_unique_session_name() -> Option<String> {
    let sessions = get_sessions().map(|sessions| {
        sessions
            .iter()
            .map(|s| s.0.clone())
            .collect::<Vec<String>>()
    });
    let dead_sessions = get_resurrectable_session_names();
    let Ok(sessions) = sessions else {
        eprintln!("Failed to list existing sessions: {:?}", sessions);
        return None;
    };

    let name = get_name_generator()
        .take(1000)
        .find(|name| !sessions.contains(name) && !dead_sessions.contains(name));

    if let Some(name) = name {
        return Some(name);
    } else {
        return None;
    }
}

/// Create a new random name generator
///
/// Used to provide a memorable handle for a session when users don't specify a session name when the session is
/// created.
///
/// Uses the list of adjectives and nouns defined below, with the intention of avoiding unfortunate
/// and offensive combinations. Care should be taken when adding or removing to either list due to the birthday paradox/
/// hash collisions, e.g. with 4096 unique names, the likelihood of a collision in 10 session names is 1%.
pub fn get_name_generator() -> impl Iterator<Item = String> {
    names::Generator::new(&ADJECTIVES, &NOUNS, names::Name::Plain)
}

const ADJECTIVES: &[&'static str] = &[
    "adamant",
    "adept",
    "adventurous",
    "arcadian",
    "auspicious",
    "awesome",
    "blossoming",
    "brave",
    "charming",
    "chatty",
    "circular",
    "considerate",
    "cubic",
    "curious",
    "delighted",
    "didactic",
    "diligent",
    "effulgent",
    "erudite",
    "excellent",
    "exquisite",
    "fabulous",
    "fascinating",
    "friendly",
    "glowing",
    "gracious",
    "gregarious",
    "hopeful",
    "implacable",
    "inventive",
    "joyous",
    "judicious",
    "jumping",
    "kind",
    "likable",
    "loyal",
    "lucky",
    "marvellous",
    "mellifluous",
    "nautical",
    "oblong",
    "outstanding",
    "polished",
    "polite",
    "profound",
    "quadratic",
    "quiet",
    "rectangular",
    "remarkable",
    "rusty",
    "sensible",
    "sincere",
    "sparkling",
    "splendid",
    "stellar",
    "tenacious",
    "tremendous",
    "triangular",
    "undulating",
    "unflappable",
    "unique",
    "verdant",
    "vitreous",
    "wise",
    "zippy",
];

const NOUNS: &[&'static str] = &[
    "aardvark",
    "accordion",
    "apple",
    "apricot",
    "bee",
    "brachiosaur",
    "cactus",
    "capsicum",
    "clarinet",
    "cowbell",
    "crab",
    "cuckoo",
    "cymbal",
    "diplodocus",
    "donkey",
    "drum",
    "duck",
    "echidna",
    "elephant",
    "foxglove",
    "galaxy",
    "glockenspiel",
    "goose",
    "hill",
    "horse",
    "iguanadon",
    "jellyfish",
    "kangaroo",
    "lake",
    "lemon",
    "lemur",
    "magpie",
    "megalodon",
    "mountain",
    "mouse",
    "muskrat",
    "newt",
    "oboe",
    "ocelot",
    "orange",
    "panda",
    "peach",
    "pepper",
    "petunia",
    "pheasant",
    "piano",
    "pigeon",
    "platypus",
    "quasar",
    "rhinoceros",
    "river",
    "rustacean",
    "salamander",
    "sitar",
    "stegosaurus",
    "tambourine",
    "tiger",
    "tomato",
    "triceratops",
    "ukulele",
    "viola",
    "weasel",
    "xylophone",
    "yak",
    "zebra",
];

#[cfg(all(test, windows))]
mod windows_session_tests {
    use super::*;
    use crate::consts::ZELLIJ_SOCK_DIR;
    use crate::ipc::{self, ClientToServerMsg, IpcReceiverWithContext, ServerToClientMsg};
    use crate::windows_utils::named_pipe::Pipe;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_session_name() -> String {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        format!("test_session_{}_{}_{}", pid, id, std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos())
    }

    /// Helper: start a mock server that responds to ConnStatus with Connected.
    /// Returns the pipe and a handle to stop the server.
    fn start_mock_session_server(session_name: &str) -> (Pipe, Arc<std::sync::atomic::AtomicBool>) {
        let path = ZELLIJ_SOCK_DIR.join(session_name);
        let pipe = ipc::bind_server(&path).expect("bind_server failed");
        let pipe_clone = pipe.clone();
        let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let running_clone = running.clone();

        std::thread::spawn(move || {
            while running_clone.load(Ordering::SeqCst) {
                match pipe_clone.accept() {
                    Ok(stream) => {
                        let mut receiver: IpcReceiverWithContext<ClientToServerMsg> =
                            IpcReceiverWithContext::new(stream);
                        if let Some((msg, _ctx)) = receiver.recv() {
                            match msg {
                                ClientToServerMsg::ConnStatus => {
                                    let mut sender =
                                        receiver.get_sender::<ServerToClientMsg>();
                                    let _ =
                                        sender.send(ServerToClientMsg::Connected);
                                },
                                ClientToServerMsg::KillSession => {
                                    // Stop the server
                                    running_clone.store(false, Ordering::SeqCst);
                                    break;
                                },
                                _ => {},
                            }
                        }
                    },
                    Err(_) => break,
                }
            }
        });

        // Give the server thread time to start listening
        std::thread::sleep(std::time::Duration::from_millis(100));

        (pipe, running)
    }

    fn cleanup_session(session_name: &str) {
        let path = ZELLIJ_SOCK_DIR.join(session_name);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_bind_creates_marker_file() {
        let name = unique_session_name();
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let _ = std::fs::create_dir_all(&*ZELLIJ_SOCK_DIR);

        let _pipe = ipc::bind_server(&path).expect("bind_server failed");

        // Marker file should exist
        assert!(path.exists(), "Marker file should exist after bind_server");

        // Cleanup
        cleanup_session(&name);
    }

    #[test]
    fn session_is_discoverable_via_wait_named_pipe() {
        let name = unique_session_name();
        let (_pipe, running) = start_mock_session_server(&name);

        // The session should be discoverable via is_socket (WaitNamedPipeW)
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let entry = std::fs::read_dir(&*ZELLIJ_SOCK_DIR)
            .expect("read_dir failed")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy() == name);
        assert!(entry.is_some(), "Session marker file should be in ZELLIJ_SOCK_DIR");

        let entry = entry.unwrap();
        let result = is_socket(&entry);
        assert!(
            result.unwrap_or(false),
            "is_socket (WaitNamedPipeW) should return true for active session"
        );

        // Cleanup
        running.store(false, Ordering::SeqCst);
        // Connect to unblock the accept() call
        let _ = Pipe::new(&path).connect();
        std::thread::sleep(std::time::Duration::from_millis(50));
        cleanup_session(&name);
    }

    #[test]
    fn session_conn_status_handshake() {
        let name = unique_session_name();
        let (_pipe, running) = start_mock_session_server(&name);

        // assert_socket should succeed (ConnStatus -> Connected)
        assert!(
            assert_socket(&name),
            "assert_socket should return true for active session with ConnStatus handler"
        );

        // Cleanup
        running.store(false, Ordering::SeqCst);
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let _ = Pipe::new(&path).connect();
        std::thread::sleep(std::time::Duration::from_millis(50));
        cleanup_session(&name);
    }

    #[test]
    fn session_appears_in_get_sessions() {
        let name = unique_session_name();
        let (_pipe, running) = start_mock_session_server(&name);

        // get_sessions should find this session
        let sessions = get_sessions().expect("get_sessions failed");
        let found = sessions.iter().any(|(s, _)| s == &name);
        assert!(
            found,
            "get_sessions() should find the test session '{}'. Found sessions: {:?}",
            name,
            sessions.iter().map(|(s, _)| s).collect::<Vec<_>>()
        );

        // Cleanup
        running.store(false, Ordering::SeqCst);
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let _ = Pipe::new(&path).connect();
        std::thread::sleep(std::time::Duration::from_millis(50));
        cleanup_session(&name);
    }

    #[test]
    fn session_exists_check() {
        let name = unique_session_name();
        let (_pipe, running) = start_mock_session_server(&name);

        // session_exists should return true
        assert!(
            session_exists(&name).unwrap_or(false),
            "session_exists() should return true for active session"
        );

        // A non-existent session should return false
        assert!(
            !session_exists("nonexistent_session_that_does_not_exist_12345").unwrap_or(true),
            "session_exists() should return false for non-existent session"
        );

        // Cleanup
        running.store(false, Ordering::SeqCst);
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let _ = Pipe::new(&path).connect();
        std::thread::sleep(std::time::Duration::from_millis(50));
        cleanup_session(&name);
    }

    #[test]
    fn session_kill_via_ipc() {
        let name = unique_session_name();
        let (_pipe, running) = start_mock_session_server(&name);

        // Verify session exists first
        assert!(
            session_exists(&name).unwrap_or(false),
            "Session should exist before kill"
        );

        // Send kill command via IPC (this is what `zellij kill-session` does)
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let stream = IpcSocketStream::connect(&path).expect("Connect for kill failed");
        let _ = crate::ipc::IpcSenderWithContext::new(stream)
            .send(ClientToServerMsg::KillSession);

        // Give the server time to process the kill and shut down
        std::thread::sleep(std::time::Duration::from_millis(200));

        // The server should have stopped
        assert!(
            !running.load(Ordering::SeqCst),
            "Server should have stopped after KillSession"
        );

        // Cleanup marker file
        cleanup_session(&name);
    }

    #[test]
    fn stale_marker_file_not_detected_as_session() {
        let name = unique_session_name();
        let path = ZELLIJ_SOCK_DIR.join(&name);
        let _ = std::fs::create_dir_all(&*ZELLIJ_SOCK_DIR);

        // Create just a marker file with no pipe behind it
        std::fs::File::create(&path).expect("Failed to create marker file");
        assert!(path.exists(), "Marker file should exist");

        // is_socket should return false (or error) since no pipe exists
        let entry = std::fs::read_dir(&*ZELLIJ_SOCK_DIR)
            .expect("read_dir failed")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy() == name);
        assert!(entry.is_some(), "Marker file should be in directory");

        let entry = entry.unwrap();
        let result = is_socket(&entry).unwrap_or(false);
        assert!(
            !result,
            "is_socket should return false for stale marker file (no pipe behind it)"
        );

        // get_sessions should NOT include this stale session
        let sessions = get_sessions().unwrap_or_default();
        let found = sessions.iter().any(|(s, _)| s == &name);
        assert!(
            !found,
            "get_sessions() should not include stale marker file as active session"
        );

        // Cleanup
        cleanup_session(&name);
    }

    #[test]
    fn multiple_sessions_discoverable() {
        let name1 = unique_session_name();
        let name2 = unique_session_name();

        let (_pipe1, running1) = start_mock_session_server(&name1);
        let (_pipe2, running2) = start_mock_session_server(&name2);

        // Both sessions should appear in get_sessions
        let sessions = get_sessions().expect("get_sessions failed");
        let found1 = sessions.iter().any(|(s, _)| s == &name1);
        let found2 = sessions.iter().any(|(s, _)| s == &name2);

        assert!(
            found1,
            "First session '{}' should be discoverable",
            name1
        );
        assert!(
            found2,
            "Second session '{}' should be discoverable",
            name2
        );

        // Cleanup
        running1.store(false, Ordering::SeqCst);
        running2.store(false, Ordering::SeqCst);
        let path1 = ZELLIJ_SOCK_DIR.join(&name1);
        let path2 = ZELLIJ_SOCK_DIR.join(&name2);
        let _ = Pipe::new(&path1).connect();
        let _ = Pipe::new(&path2).connect();
        std::thread::sleep(std::time::Duration::from_millis(50));
        cleanup_session(&name1);
        cleanup_session(&name2);
    }
}
