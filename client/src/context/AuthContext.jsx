import { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [additionalRoles, setAdditionalRoles] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Check for existing token
        const token = localStorage.getItem('token');
        const savedUser = localStorage.getItem('user');

        if (token && savedUser) {
            try {
                setUser(JSON.parse(savedUser));
                // Fetch additional roles on initial load
                authAPI.me().then(response => {
                    if (response.data.additional_roles) {
                        setAdditionalRoles(response.data.additional_roles);
                    }
                }).catch(() => {
                    localStorage.removeItem('token');
                    localStorage.removeItem('user');
                });
            } catch (e) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
            }
        }
        setLoading(false);
    }, []);

    // Fetch additional roles from API
    const fetchAdditionalRoles = async () => {
        try {
            const response = await authAPI.me();
            if (response.data.additional_roles) {
                setAdditionalRoles(response.data.additional_roles);
            }
        } catch (error) {
            console.error('Failed to fetch additional roles:', error);
        }
    };

    const login = async (username, password) => {
        const response = await authAPI.login(username, password);
        const { token, user } = response.data;

        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        setUser(user);

        // Fetch additional roles after login
        try {
            const meResponse = await authAPI.me();
            if (meResponse.data.additional_roles) {
                setAdditionalRoles(meResponse.data.additional_roles);
            }
        } catch (error) {
            console.error('Failed to fetch additional roles:', error);
        }

        return user;
    };

    const logout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
        setAdditionalRoles([]);
    };

    const value = {
        user,
        additionalRoles,
        loading,
        login,
        logout,
        fetchAdditionalRoles,
        isAdmin: user?.role === 'admin' || additionalRoles.includes('admin'),
        isManager: user?.role === 'manager' || additionalRoles.includes('manager'),
        isCaller: user?.role === 'caller' || additionalRoles.includes('caller'),
        isAuthenticated: !!user
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
